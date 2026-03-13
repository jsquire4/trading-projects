/**
 * helpers.ts — Wallet funding, market state reading, order book parsing,
 * and transaction helpers for the Really Stressful Test.
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
  IS_PAUSED: 402,
  IS_CLOSED: 403,
  OVERRIDE_COUNT: 404,
  BUMP: 405,
};

export interface MarketState {
  isSettled: boolean;
  outcome: number;
  isPaused: boolean;
  isClosed: boolean;
  totalMinted: bigint;
  totalRedeemed: bigint;
  settlementPrice: bigint;
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
    isPaused: d[SM.IS_PAUSED] !== 0,
    isClosed: d[SM.IS_CLOSED] !== 0,
    totalMinted: d.readBigUInt64LE(SM.TOTAL_MINTED),
    totalRedeemed: d.readBigUInt64LE(SM.TOTAL_REDEEMED),
    settlementPrice: d.readBigUInt64LE(SM.SETTLEMENT_PRICE),
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
 * Parse the on-chain OrderBook binary data to find active orders.
 *
 * Layout (after 8-byte Anchor discriminator):
 *   market:        32 bytes
 *   next_order_id: 8 bytes
 *   levels[99]:    each = 32 × OrderSlot(80 bytes) + count(1) + padding(7) = 2568 bytes
 *   bump:          1 byte
 *   padding:       7 bytes
 *
 * OrderSlot (80 bytes):
 *   owner(32) + order_id(8) + quantity(8) + original_quantity(8)
 *   + side(1) + _side_padding(7) + timestamp(8) + is_active(1) + _padding(7)
 */
export function parseOrderBook(data: Buffer): ParsedOrder[] {
  const orders: ParsedOrder[] = [];
  const HEADER = 8 + 32 + 8; // disc + market + next_order_id = 48
  const SLOT_SIZE = 80;
  const SLOTS_PER_LEVEL = 32;
  const LEVEL_SIZE = SLOTS_PER_LEVEL * SLOT_SIZE + 1 + 7; // 2568

  for (let lvl = 0; lvl < 99; lvl++) {
    const levelOffset = HEADER + lvl * LEVEL_SIZE;
    const count = data[levelOffset + SLOTS_PER_LEVEL * SLOT_SIZE];
    if (count === 0) continue;

    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      const slotOffset = levelOffset + s * SLOT_SIZE;
      const isActive = data[slotOffset + 32 + 8 + 8 + 8 + 1 + 7 + 8] !== 0; // offset 72
      if (!isActive) continue;

      const owner = new PublicKey(data.subarray(slotOffset, slotOffset + 32));
      const orderId = data.readBigUInt64LE(slotOffset + 32);
      const quantity = data.readBigUInt64LE(slotOffset + 40);
      const side = data[slotOffset + 56]; // offset 32+8+8+8 = 56

      orders.push({
        priceLevel: lvl + 1,
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
      // Retry on blockhash / duplicate tx errors, not on program errors
      const isTransient = msg.includes("blockhash") || msg.includes("was already processed");
      if (attempt < maxRetries && isTransient) {
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

/** Batch items into groups of batchSize. */
export function batch<T>(items: T[], batchSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    result.push(items.slice(i, i + batchSize));
  }
  return result;
}
