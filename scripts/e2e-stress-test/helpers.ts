/**
 * helpers.ts — Wallet funding, market state reading, order book parsing,
 * and transaction helpers for the E2E Stress Test.
 *
 * Extracted from scripts/stress-test/helpers.ts when the older stress tests
 * were removed.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  findPriceFeed,
  findGlobalConfig,
  findTreasury,
  findFeeVault,
  padTicker,
  MERIDIAN_PROGRAM_ID,
} from "../../services/shared/src/pda";

// Re-export PDA finders for convenience
export {
  findGlobalConfig,
  findTreasury,
  findFeeVault,
  findPriceFeed,
  padTicker,
  MERIDIAN_PROGRAM_ID,
};

// ---------------------------------------------------------------------------
// Wallet funding
// ---------------------------------------------------------------------------

/**
 * Fund a single wallet with SOL (airdrop) and USDC (mint via faucet).
 * Creates the USDC ATA if it doesn't exist.
 */
export async function fundWallet(
  connection: Connection,
  payer: Keypair,
  faucetKp: Keypair,
  usdcMint: PublicKey,
  wallet: Keypair,
  solAmount: number,
  usdcAmount: number,
): Promise<void> {
  // Airdrop SOL
  const sig = await connection.requestAirdrop(
    wallet.publicKey,
    solAmount * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(sig, "confirmed");

  // Create USDC ATA and mint
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    wallet.publicKey,
  );
  await mintTo(connection, payer, usdcMint, ata.address, faucetKp, usdcAmount);
}

// ---------------------------------------------------------------------------
// Market state reading
// ---------------------------------------------------------------------------

/** StrikeMarket field offsets (after 8-byte Anchor discriminator). */
const SM = {
  DISC: 8,
  CONFIG: 8,             // 8
  YES_MINT: 40,           // 8 + 32
  NO_MINT: 72,            // 8 + 64
  USDC_VAULT: 104,        // 8 + 96
  ESCROW_VAULT: 136,
  YES_ESCROW: 168,
  NO_ESCROW: 200,
  ORDER_BOOK: 232,
  ORACLE_FEED: 264,
  STRIKE_PRICE: 296,      // 8 + 9*32
  MARKET_CLOSE_UNIX: 304,
  TOTAL_MINTED: 312,
  TOTAL_REDEEMED: 320,
  SETTLEMENT_PRICE: 328,
  PREVIOUS_CLOSE: 336,
  SETTLED_AT: 344,
  OVERRIDE_DEADLINE: 352,
  ALT_ADDRESS: 360,
  TICKER: 392,
  IS_SETTLED: 400,
  OUTCOME: 401,
  OVERRIDE_COUNT: 402,
  BUMP: 403,
  // _padding: [u8; 4] at 404-407
};

export interface MarketState {
  isSettled: boolean;
  outcome: number;
  overrideCount: number;
  totalMinted: bigint;
  totalRedeemed: bigint;
  settlementPrice: bigint;
  settledAt: bigint;
  overrideDeadline: bigint;
}

/** Read key fields from an on-chain StrikeMarket account. */
export async function readMarketState(
  connection: Connection,
  marketPda: PublicKey,
): Promise<MarketState | null> {
  const acct = await connection.getAccountInfo(marketPda);
  if (!acct) return null;
  const d = Buffer.from(acct.data);
  return {
    isSettled: d[SM.IS_SETTLED] !== 0,
    outcome: d[SM.OUTCOME],
    overrideCount: d[SM.OVERRIDE_COUNT],
    totalMinted: d.readBigUInt64LE(SM.TOTAL_MINTED),
    totalRedeemed: d.readBigUInt64LE(SM.TOTAL_REDEEMED),
    settlementPrice: d.readBigUInt64LE(SM.SETTLEMENT_PRICE),
    settledAt: d.readBigInt64LE(SM.SETTLED_AT),
    overrideDeadline: d.readBigInt64LE(SM.OVERRIDE_DEADLINE),
  };
}

/** Read the USDC vault balance. */
export async function readVaultBalance(
  connection: Connection,
  vaultPda: PublicKey,
): Promise<bigint> {
  try {
    const acct = await getAccount(connection, vaultPda);
    return acct.amount;
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Order book parsing
// ---------------------------------------------------------------------------

/** An active order parsed from the on-chain order book. */
export interface ParsedOrder {
  priceLevel: number;   // 1-99
  slotIndex: number;
  owner: PublicKey;
  orderId: bigint;
  quantity: bigint;
  side: number;
  isActive: boolean;
}

/**
 * Parse the on-chain OrderBook sparse binary data to find active orders.
 *
 * Sparse layout — Header (270 bytes):
 *   [0..8]     discriminator
 *   [8..40]    market: Pubkey
 *   [40..48]   next_order_id: u64
 *   [48..246]  price_map: [u16 LE; 99] — byte offsets into level data, 0xFFFF = unallocated
 *   [246]      level_count: u8
 *   [247]      max_levels: u8
 *   [248]      bump: u8
 *   [249..270] _reserved
 *
 * Level entry (variable size: 8 + slot_count × 112 bytes):
 *   [0]   price: u8
 *   [1]   active_count: u8
 *   [2]   slot_count: u8
 *   [3..8] _padding
 *   [8..] orders: [OrderSlot; slot_count]
 *
 * OrderSlot (112 bytes):
 *   owner(32) + order_id(8) + quantity(8) + original_quantity(8)
 *   + side(1) + _side_padding(7) + timestamp(8) + is_active(1) + _padding(7)
 *   + rent_depositor(32)
 */
export function parseOrderBook(data: Buffer): ParsedOrder[] {
  const orders: ParsedOrder[] = [];
  const HEADER_SIZE = 270;
  const SLOT_SIZE = 112;
  const LEVEL_HEADER_SIZE = 8;
  const PRICE_MAP_OFFSET = 48;
  const PRICE_MAP_LEN = 99;
  const UNALLOCATED = 0xffff;

  for (let priceIdx = 0; priceIdx < PRICE_MAP_LEN; priceIdx++) {
    // Price map entries are u16 LE — byte offsets relative to end of header
    const byteOffset = data.readUInt16LE(PRICE_MAP_OFFSET + priceIdx * 2);
    if (byteOffset === UNALLOCATED) continue;

    const levelOffset = HEADER_SIZE + byteOffset;
    if (levelOffset + LEVEL_HEADER_SIZE > data.length) continue;

    const activeCount = data[levelOffset + 1];
    if (activeCount === 0) continue;

    const slotCount = data[levelOffset + 2];

    for (let s = 0; s < slotCount; s++) {
      const slotOffset = levelOffset + LEVEL_HEADER_SIZE + s * SLOT_SIZE;
      if (slotOffset + SLOT_SIZE > data.length) break;

      const isActive = data[slotOffset + 72] !== 0;
      if (!isActive) continue;

      const owner = new PublicKey(data.subarray(slotOffset, slotOffset + 32));
      const orderId = data.readBigUInt64LE(slotOffset + 32);
      const quantity = data.readBigUInt64LE(slotOffset + 40);
      const side = data[slotOffset + 56];

      orders.push({
        priceLevel: priceIdx + 1,
        slotIndex: s,
        owner,
        orderId,
        quantity,
        side,
        isActive: true,
      });
    }
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/** Send a transaction with retry on transient failures. */
export async function sendTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts?: { skipPreflight?: boolean; maxRetries?: number },
): Promise<string> {
  const maxRetries = opts?.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: "confirmed",
        skipPreflight: opts?.skipPreflight ?? false,
      });
    } catch (e: any) {
      const msg = e.message ?? "";
      const msgLower = msg.toLowerCase();
      // Retry on blockhash / block height / timeout errors, not on program errors
      const isTransient =
        msgLower.includes("blockhash") ||
        msgLower.includes("block height") ||
        msgLower.includes("expired") ||
        msgLower.includes("was already processed") ||
        msgLower.includes("timeout") ||
        msgLower.includes("socket hang up");
      if (attempt < maxRetries && isTransient) {
        console.log(`    ↻ retry ${attempt + 1}/${maxRetries}: ${msg.slice(0, 80)}`);
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Batch items into groups of batchSize. */
export function batch<T>(items: T[], batchSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    result.push(items.slice(i, i + batchSize));
  }
  return result;
}
