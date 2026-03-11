/**
 * seed-asks.ts — Mint pairs and post Yes-side ask orders on all existing markets.
 *
 * Run after create-test-markets.ts to add sell-side liquidity so users can
 * execute market buy orders.
 *
 * Uses the same MAG7 specs and PDA derivation as create-test-markets.ts.
 *
 * Run:  npx ts-node scripts/seed-asks.ts
 */

import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import * as path from "path";

import {
  loadKeypair,
  readEnv,
  padTicker,
  todayMarketCloseUnix,
  buildPlaceOrderIx,
  buildMintPairIx,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "./shared";
import { binaryCallPrice, probToCents } from "../services/amm-bot/src/pricer";
import { generateQuotes } from "../services/amm-bot/src/quoter";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json",
);

const ASK_QTY = 200;
const DEFAULT_VOL = 0.35;
const SEED_LEVELS = 3;

const MAG7_PRICES: Record<string, number> = {
  AAPL: 198, MSFT: 420, GOOGL: 175, AMZN: 200,
  NVDA: 130, META: 600, TSLA: 250,
};

function roundToNearest(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

function generateStrikes(previousClose: number): number[] {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const increment = previousClose >= 100 ? 10 : 5;
  const rawStrikes = offsets.map((pct) =>
    roundToNearest(previousClose * (1 + pct), increment),
  );
  return [...new Set(rawStrikes)].sort((a, b) => a - b);
}

function expiryDayFromUnix(unix: number): number {
  return Math.floor(unix / 86400);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const env = readEnv(ENV_PATH);
  if (!env["USDC_MINT"]) {
    console.error("ERROR: USDC_MINT not found in .env.");
    process.exit(1);
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PROGRAM_ID);
  const marketCloseUnix = todayMarketCloseUnix();
  const expiryDay = expiryDayFromUnix(marketCloseUnix);

  // Build same spec list as create-test-markets.ts
  const specs: { ticker: string; strikeDollars: number; spotPrice: number }[] = [];
  for (const [ticker, price] of Object.entries(MAG7_PRICES)) {
    for (const strike of generateStrikes(price)) {
      specs.push({ ticker, strikeDollars: strike, spotPrice: price });
    }
  }

  console.log(`Processing ${specs.length} markets...\n`);

  let minted = 0;
  let asked = 0;
  let skipped = 0;
  let failed = 0;

  for (const spec of specs) {
    const strikeLamports = new BN(spec.strikeDollars * 1_000_000);
    const tBytes = padTicker(spec.ticker);
    const label = `${spec.ticker} $${spec.strikeDollars}`;

    // Derive PDAs
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), tBytes, strikeLamports.toArrayLike(Buffer, "le", 8), new BN(expiryDay).toArrayLike(Buffer, "le", 4)],
      MERIDIAN_PROGRAM_ID,
    );
    const mkSeed = marketPda.toBuffer();
    const [yesMint] = PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [noMint] = PublicKey.findProgramAddressSync([Buffer.from("no_mint"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [usdcVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [escrowVault] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [yesEscrow] = PublicKey.findProgramAddressSync([Buffer.from("yes_escrow"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [noEscrow] = PublicKey.findProgramAddressSync([Buffer.from("no_escrow"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [orderBook] = PublicKey.findProgramAddressSync([Buffer.from("order_book"), mkSeed], MERIDIAN_PROGRAM_ID);
    const [oracleFeed] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), tBytes], MOCK_ORACLE_PROGRAM_ID);

    // Check if market exists
    const existing = await connection.getAccountInfo(marketPda);
    if (!existing) {
      skipped++;
      continue;
    }

    try {
      // Ensure ATAs exist
      const adminYesAta = getAssociatedTokenAddressSync(yesMint, admin.publicKey);
      const adminNoAta = getAssociatedTokenAddressSync(noMint, admin.publicKey);
      const adminUsdcAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);

      const ataSetupTx = new Transaction();
      ataSetupTx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminUsdcAta, admin.publicKey, usdcMint));
      ataSetupTx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminYesAta, admin.publicKey, yesMint));
      ataSetupTx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminNoAta, admin.publicKey, noMint));
      await sendAndConfirmTransaction(connection, ataSetupTx, [admin], { commitment: "confirmed" });

      // Check current Yes balance
      let yesBalance = BigInt(0);
      try {
        const yesAcct = await getAccount(connection, adminYesAta, "confirmed");
        yesBalance = yesAcct.amount;
      } catch {
        // ATA doesn't exist yet
      }

      const perLevelLamports = ASK_QTY * 1_000_000;
      const totalNeeded = perLevelLamports * SEED_LEVELS;

      // Mint pairs if admin doesn't have enough Yes tokens
      if (yesBalance < BigInt(totalNeeded)) {
        if (yesBalance > BigInt(0)) {
          console.log(`  ${label}: Using existing ${Number(yesBalance) / 1e6} Yes tokens`);
        } else {
          const mintIx = buildMintPairIx(admin, {
            market: marketPda, yesMint, noMint, usdcVault, configPda, usdcMint,
          }, totalNeeded);
          await sendAndConfirmTransaction(connection, new Transaction().add(mintIx), [admin], { commitment: "confirmed" });
          yesBalance = BigInt(totalNeeded);
          minted++;
        }
      }

      // Compute ask price via Black-Scholes
      const nowUnix = Math.floor(Date.now() / 1000);
      const hoursToExpiry = Math.max(0.1, (marketCloseUnix - nowUnix) / 3600);
      const T = hoursToExpiry / 8760;
      const fairProb = binaryCallPrice(spec.spotPrice, spec.strikeDollars, DEFAULT_VOL, T);
      const quote = generateQuotes(fairProb, 0);

      if (Number(yesBalance) < 1_000_000) {
        console.log(`  ${label}: Insufficient Yes balance for ask — skipping`);
        skipped++;
        continue;
      }

      const marketAddrs = {
        market: marketPda, yesMint, noMint, usdcVault, escrowVault,
        yesEscrow, noEscrow, orderBook, oracleFeed,
      };

      // Post asks at multiple price levels (askPrice, askPrice+1, askPrice+2)
      for (let lvl = 0; lvl < SEED_LEVELS; lvl++) {
        const askPrice = Math.min(99, quote.askPrice + lvl);
        const lvlQty = Math.round(perLevelLamports * (1 - lvl * 0.25));
        const askIx = buildPlaceOrderIx(configPda, admin, marketAddrs, usdcMint, 1, askPrice, lvlQty, 1, 0);
        await sendAndConfirmTransaction(connection, new Transaction().add(askIx), [admin], { commitment: "confirmed" });
      }
      asked++;
      console.log(`  [${asked}] ${label}  fair=${probToCents(fairProb)}c  ask=${quote.askPrice}c  levels=${SEED_LEVELS}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAILED: ${label} — ${err.message?.slice(0, 150)}`);
      const logs = err?.logs ?? [];
      const progErr = logs.find((l: string) => l.includes("Error") || l.includes("failed"));
      if (progErr) console.error(`    Log: ${progErr}`);
    }
  }

  console.log(`\n=== Seed asks complete ===`);
  console.log(`  Minted: ${minted}`);
  console.log(`  Asked:  ${asked}`);
  console.log(`  Skipped: ${skipped} (no market or insufficient balance)`);
  console.log(`  Failed: ${failed}`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
