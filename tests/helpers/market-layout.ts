/**
 * market-layout.ts — Helpers for reading on-chain StrikeMarket account data
 * and token balances in bankrun tests.
 */

import { PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";
import BN from "bn.js";
import { Clock } from "solana-bankrun";
import { BankrunContext } from "./setup";
import { buildCrankCancelIx } from "./instructions";

// ---------------------------------------------------------------------------
// StrikeMarket byte offsets (after 8-byte Anchor discriminator)
// ---------------------------------------------------------------------------

const MARKET_DISC = 8;
const MARKET_PUBKEYS = 9 * 32; // 288

export const OFF_STRIKE_PRICE = MARKET_DISC + MARKET_PUBKEYS; // 296
export const OFF_MARKET_CLOSE = OFF_STRIKE_PRICE + 8; // 304
export const OFF_TOTAL_MINTED = OFF_MARKET_CLOSE + 8; // 312
export const OFF_TOTAL_REDEEMED = OFF_TOTAL_MINTED + 8; // 320
export const OFF_SETTLEMENT_PRICE = OFF_TOTAL_REDEEMED + 8; // 328
export const OFF_PREVIOUS_CLOSE = OFF_SETTLEMENT_PRICE + 8; // 336
export const OFF_SETTLED_AT = OFF_PREVIOUS_CLOSE + 8; // 344
export const OFF_OVERRIDE_DEADLINE = OFF_SETTLED_AT + 8; // 352
// alt_address(32) at 360, ticker(8) at 392
export const OFF_IS_SETTLED = 400;
export const OFF_OUTCOME = 401;
export const OFF_OVERRIDE_COUNT = 402;

// ---------------------------------------------------------------------------
// StrikeMarket field reader
// ---------------------------------------------------------------------------

export interface MarketFields {
  strikePrice: number;
  marketCloseUnix: number;
  totalMinted: number;
  totalRedeemed: number;
  settlementPrice: number;
  previousClose: number;
  settledAt: number;
  overrideDeadline: number;
  isSettled: boolean;
  outcome: number;
  overrideCount: number;
}

/**
 * Parse all relevant fields from a raw StrikeMarket account data buffer.
 */
export function readMarketFields(data: Buffer): MarketFields {
  return {
    strikePrice: new BN(data.subarray(OFF_STRIKE_PRICE, OFF_STRIKE_PRICE + 8), "le").toNumber(),
    marketCloseUnix: new BN(data.subarray(OFF_MARKET_CLOSE, OFF_MARKET_CLOSE + 8), "le").toNumber(),
    totalMinted: new BN(data.subarray(OFF_TOTAL_MINTED, OFF_TOTAL_MINTED + 8), "le").toNumber(),
    totalRedeemed: new BN(data.subarray(OFF_TOTAL_REDEEMED, OFF_TOTAL_REDEEMED + 8), "le").toNumber(),
    settlementPrice: new BN(data.subarray(OFF_SETTLEMENT_PRICE, OFF_SETTLEMENT_PRICE + 8), "le").toNumber(),
    previousClose: new BN(data.subarray(OFF_PREVIOUS_CLOSE, OFF_PREVIOUS_CLOSE + 8), "le").toNumber(),
    settledAt: new BN(data.subarray(OFF_SETTLED_AT, OFF_SETTLED_AT + 8), "le").toNumber(),
    overrideDeadline: new BN(data.subarray(OFF_OVERRIDE_DEADLINE, OFF_OVERRIDE_DEADLINE + 8), "le").toNumber(),
    isSettled: data[OFF_IS_SETTLED] !== 0,
    outcome: data[OFF_OUTCOME],
    overrideCount: data[OFF_OVERRIDE_COUNT],
  };
}

/**
 * Fetch and parse a StrikeMarket account from bankrun context.
 */
export async function readMarket(
  ctx: BankrunContext,
  market: PublicKey,
): Promise<MarketFields> {
  const acct = await ctx.context.banksClient.getAccount(market);
  return readMarketFields(Buffer.from(acct!.data));
}

// ---------------------------------------------------------------------------
// Token balance helper
// ---------------------------------------------------------------------------

/**
 * Read the token balance of an SPL Token account.
 * Returns 0 if the account doesn't exist.
 */
export async function getTokenBalance(
  ctx: BankrunContext,
  ata: PublicKey,
): Promise<number> {
  const acct = await ctx.context.banksClient.getAccount(ata);
  if (!acct) return 0;
  const data = Buffer.from(acct.data);
  // SPL Token account: amount is at offset 64, u64 LE
  return new BN(data.subarray(64, 72), "le").toNumber();
}

// ---------------------------------------------------------------------------
// Clock advancement helper
// ---------------------------------------------------------------------------

/**
 * Advance the bankrun clock's unix_timestamp while preserving other fields.
 * The Clock object from getClock() uses non-enumerable getters, so spread
 * doesn't work — we must copy each field explicitly.
 */
export async function advanceClock(
  ctx: BankrunContext,
  unixTimestamp: number,
): Promise<void> {
  const clock = await ctx.context.banksClient.getClock();
  ctx.context.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(unixTimestamp),
    ),
  );
}

// ---------------------------------------------------------------------------
// Mint supply reader
// ---------------------------------------------------------------------------

/**
 * Read the total supply of an SPL Mint account.
 * Returns 0n if the account doesn't exist.
 */
export async function getMintSupply(
  ctx: BankrunContext,
  mint: PublicKey,
): Promise<bigint> {
  const acct = await ctx.context.banksClient.getAccount(mint);
  if (!acct) return 0n;
  const data = Buffer.from(acct.data);
  // SPL Mint account: supply is at offset 36, u64 LE
  return data.readBigUInt64LE(36);
}

// ---------------------------------------------------------------------------
// Crank cancel helper
// ---------------------------------------------------------------------------

/**
 * Attempt crank_cancel; ignore CrankNotNeeded (0x17ca) when the book is already empty.
 */
export async function tryCrankCancel(
  prov: BankrunProvider,
  params: {
    caller: PublicKey;
    config: PublicKey;
    market: PublicKey;
    orderBook: PublicKey;
    escrowVault: PublicKey;
    yesEscrow: PublicKey;
    noEscrow: PublicKey;
  },
  signers: Keypair[],
  uniqueCuIx?: () => TransactionInstruction,
): Promise<void> {
  try {
    const ixs: TransactionInstruction[] = [];
    if (uniqueCuIx) ixs.push(uniqueCuIx());
    ixs.push(
      buildCrankCancelIx({
        ...params,
        batchSize: 32,
      }),
    );
    await prov.sendAndConfirm!(new Transaction().add(...ixs), signers);
  } catch (e: any) {
    if (!e.toString().includes("0x17ca")) throw e;
  }
}
