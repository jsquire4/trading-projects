/**
 * scripts/shared.ts — Shared utilities for Meridian deployment and test scripts.
 *
 * Consolidates duplicated helpers from load-test.ts and create-test-markets.ts.
 */

import { Keypair, PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

// Re-export padTicker from the canonical source
export { padTicker } from "../services/shared/src/pda";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MERIDIAN_PROGRAM_ID = new PublicKey(
  "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth",
);

export const MOCK_ORACLE_PROGRAM_ID = new PublicKey(
  "HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ",
);

// ---------------------------------------------------------------------------
// File / env helpers
// ---------------------------------------------------------------------------

export function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function readEnv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Anchor discriminator
// ---------------------------------------------------------------------------

/** Compute Anchor instruction discriminator: first 8 bytes of SHA256("global:<name>"). */
export function anchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.subarray(0, 8);
}

// ---------------------------------------------------------------------------
// Market close time
// ---------------------------------------------------------------------------

/** Compute today's 4 PM ET market close unix timestamp. */
export function todayMarketCloseUnix(): number {
  const now = new Date();
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = etFormatter.formatToParts(now);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const etYear = parseInt(getPart("year"));
  const etMonth = parseInt(getPart("month")) - 1;
  const etDay = parseInt(getPart("day"));

  const etDateStr = `${getPart("year")}-${getPart("month")}-${getPart("day")}T${getPart("hour")}:${getPart("minute")}:${getPart("second")}`;
  const etDateUtc = new Date(etDateStr + "Z");
  const diffMs = now.getTime() - etDateUtc.getTime();
  const etOffsetHours = Math.round(diffMs / (3600 * 1000));

  const closeUtcMs = new Date(
    Date.UTC(etYear, etMonth, etDay, 16 + etOffsetHours, 0, 0),
  ).getTime();

  const closeUnix = Math.floor(closeUtcMs / 1000);
  if (closeUnix <= Math.floor(Date.now() / 1000)) {
    return closeUnix + 86400;
  }
  return closeUnix;
}

// ---------------------------------------------------------------------------
// Place order instruction builder (for scripts)
// ---------------------------------------------------------------------------

export interface ScriptMarketAddresses {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
}

/**
 * Build a place_order TransactionInstruction for use in scripts.
 * This is a simplified version compared to the test helpers — it takes
 * scalar side/price/quantity rather than a params object.
 */
export function buildPlaceOrderIx(
  configPda: PublicKey,
  wallet: Keypair,
  m: ScriptMarketAddresses,
  usdcMint: PublicKey,
  side: number,
  price: number,
  quantity: number,
  orderType: number = 1, // default: limit
  maxFills: number = 5,
): TransactionInstruction {
  const disc = anchorDiscriminator("place_order");
  const data = Buffer.concat([
    disc,
    Buffer.from([side]),
    Buffer.from([price]),
    new BN(quantity).toArrayLike(Buffer, "le", 8),
    Buffer.from([orderType]),
    Buffer.from([maxFills]),
  ]);

  const walletUsdcAta = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  const walletYesAta = getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey);
  const walletNoAta = getAssociatedTokenAddressSync(m.noMint, wallet.publicKey);

  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: m.market, isSigner: false, isWritable: true },
    { pubkey: m.orderBook, isSigner: false, isWritable: true },
    { pubkey: m.usdcVault, isSigner: false, isWritable: true },
    { pubkey: m.escrowVault, isSigner: false, isWritable: true },
    { pubkey: m.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: m.noEscrow, isSigner: false, isWritable: true },
    { pubkey: m.yesMint, isSigner: false, isWritable: true },
    { pubkey: m.noMint, isSigner: false, isWritable: true },
    { pubkey: walletUsdcAta, isSigner: false, isWritable: true },
    { pubkey: walletYesAta, isSigner: false, isWritable: true },
    { pubkey: walletNoAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: MERIDIAN_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// Mint pair instruction builder (for scripts)
// ---------------------------------------------------------------------------

export interface MintPairAddresses {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  configPda: PublicKey;
  usdcMint: PublicKey;
}

/**
 * Build a mint_pair TransactionInstruction.
 * Mints equal quantities of Yes + No tokens by depositing USDC.
 */
export function buildMintPairIx(
  wallet: Keypair,
  m: MintPairAddresses,
  quantity: number, // in lamports (1 token = 1_000_000)
): TransactionInstruction {
  const disc = anchorDiscriminator("mint_pair");
  const data = Buffer.concat([disc, new BN(quantity).toArrayLike(Buffer, "le", 8)]);

  const walletUsdcAta = getAssociatedTokenAddressSync(m.usdcMint, wallet.publicKey);
  const walletYesAta = getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey);
  const walletNoAta = getAssociatedTokenAddressSync(m.noMint, wallet.publicKey);

  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: m.configPda, isSigner: false, isWritable: false },
    { pubkey: m.market, isSigner: false, isWritable: true },
    { pubkey: m.yesMint, isSigner: false, isWritable: true },
    { pubkey: m.noMint, isSigner: false, isWritable: true },
    { pubkey: walletUsdcAta, isSigner: false, isWritable: true },
    { pubkey: walletYesAta, isSigner: false, isWritable: true },
    { pubkey: walletNoAta, isSigner: false, isWritable: true },
    { pubkey: m.usdcVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: MERIDIAN_PROGRAM_ID, keys, data });
}
