/**
 * create-test-markets.ts — Create strike markets for all 7 MAG7 stocks,
 * mint pairs, and seed initial liquidity using Black-Scholes pricing.
 *
 * Generates strikes at ±3%, ±6%, ±9% from each stock's reference price,
 * rounded to nearest $10 (or $5 for stocks <$100). Deduplicates overlapping
 * strikes. Creates ~35-42 markets total.
 *
 * After creation, seeds two-sided liquidity in three passes:
 *   Pass 1: Create markets (idempotent — skips existing)
 *   Pass 2: Post USDC-backed bids (side=0) — must happen before minting
 *            to avoid position conflicts (side=0 requires No balance=0)
 *   Pass 3: Mint Yes/No pairs, then post Yes asks (side=1)
 *
 * Prices are computed via Black-Scholes N(d2) with 5% half-spread.
 *
 * Idempotent: skips markets that already exist on-chain.
 * Each market requires ~127KB OrderBook allocation (~3 batched txns) + ALT.
 *
 * Run:  npx ts-node scripts/create-test-markets.ts
 */

import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import * as path from "path";

import {
  loadKeypair,
  readEnv,
  padTicker,
  anchorDiscriminator,
  todayMarketCloseUnix,
  buildPlaceOrderIx,
  buildMintPairIx,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "./shared";
import { createMarketDataClient } from "../services/shared/src/market-data";
import { binaryCallPrice, probToCents } from "../services/amm-bot/src/pricer";
import { generateQuotes } from "../services/amm-bot/src/quoter";

// Fallback prices — only used if market data API is unavailable
const MAG7_FALLBACK: Record<string, number> = {
  AAPL: 198, MSFT: 420, GOOGL: 175, AMZN: 200,
  NVDA: 130, META: 600, TSLA: 250,
};

const TICKERS = (process.env.TICKERS ?? "AAPL,TSLA,AMZN,MSFT,NVDA,GOOGL,META")
  .split(",").map((t) => t.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Strike generation (same algorithm as services/shared/src/strikes.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json",
);

const QUOTE_QTY = 200; // Post 200-token orders per price level per market
const DEFAULT_VOL = 0.35; // 35% annualized volatility for seed pricing
const SEED_LEVELS = 3; // Seed bids/asks at 3 price levels around fair value

function expiryDayFromUnix(unix: number): number {
  return Math.floor(unix / 86400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Market creation helpers
// ---------------------------------------------------------------------------

interface MarketAddresses {
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
  usdcMint: PublicKey;
  configPda: PublicKey;
  marketPda: PublicKey;
}

function deriveMarketPDAs(
  ticker: string,
  strikeLamports: BN,
  expiryDay: number,
  usdcMint: PublicKey,
  configPda: PublicKey,
): MarketAddresses {
  const tBytes = padTicker(ticker);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      tBytes,
      strikeLamports.toArrayLike(Buffer, "le", 8),
      new BN(expiryDay).toArrayLike(Buffer, "le", 4),
    ],
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

  return {
    marketPda, yesMint, noMint, usdcVault, escrowVault,
    yesEscrow, noEscrow, orderBook, oracleFeed, usdcMint, configPda,
  };
}

async function createMarket(
  connection: Connection,
  admin: Keypair,
  ticker: string,
  strikeLamports: BN,
  previousCloseLamports: BN,
  marketCloseUnix: number,
  addrs: MarketAddresses,
): Promise<void> {
  const tBytes = padTicker(ticker);
  const expiryDay = expiryDayFromUnix(marketCloseUnix);
  const disc = anchorDiscriminator("create_strike_market");

  const [tickerRegistryPda] = PublicKey.findProgramAddressSync([Buffer.from("tickers")], MERIDIAN_PROGRAM_ID);
  const [solTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("sol_treasury")], MERIDIAN_PROGRAM_ID);

  const data = Buffer.concat([
    disc,
    tBytes,
    strikeLamports.toArrayLike(Buffer, "le", 8),
    new BN(expiryDay).toArrayLike(Buffer, "le", 4),
    new BN(marketCloseUnix).toArrayLike(Buffer, "le", 8),
    previousCloseLamports.toArrayLike(Buffer, "le", 8),
  ]);

  const keys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: addrs.configPda, isSigner: false, isWritable: false },
    { pubkey: addrs.marketPda, isSigner: false, isWritable: true },
    { pubkey: addrs.yesMint, isSigner: false, isWritable: true },
    { pubkey: addrs.noMint, isSigner: false, isWritable: true },
    { pubkey: addrs.usdcVault, isSigner: false, isWritable: true },
    { pubkey: addrs.escrowVault, isSigner: false, isWritable: true },
    { pubkey: addrs.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: addrs.noEscrow, isSigner: false, isWritable: true },
    { pubkey: addrs.orderBook, isSigner: false, isWritable: true },
    { pubkey: addrs.oracleFeed, isSigner: false, isWritable: false },
    { pubkey: addrs.usdcMint, isSigner: false, isWritable: false },
    // Optional accounts: creator_usdc_ata, fee_vault (None for admin), ticker_registry, sol_treasury
    { pubkey: MERIDIAN_PROGRAM_ID, isSigner: false, isWritable: false }, // creator_usdc_ata = None
    { pubkey: MERIDIAN_PROGRAM_ID, isSigner: false, isWritable: false }, // fee_vault = None
    { pubkey: tickerRegistryPda, isSigner: false, isWritable: false },   // ticker_registry
    { pubkey: solTreasuryPda, isSigner: false, isWritable: true },        // sol_treasury
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  const tx = new Transaction().add(new TransactionInstruction({ programId: MERIDIAN_PROGRAM_ID, keys, data }));
  await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
}

async function createAndSetAlt(
  connection: Connection,
  admin: Keypair,
  addrs: MarketAddresses,
): Promise<void> {
  // Warmup tx to guarantee a recent slot with a block
  const warmupSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: admin.publicKey, lamports: 1 })),
    [admin],
    { commitment: "confirmed" },
  );
  const warmupTx = await connection.getTransaction(warmupSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const slot = warmupTx?.slot ?? (await connection.getSlot("confirmed"));

  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: admin.publicKey,
    payer: admin.publicKey,
    recentSlot: slot,
  });

  await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [admin], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  const addressesToAdd = [
    addrs.configPda, addrs.marketPda, addrs.yesMint, addrs.noMint,
    addrs.usdcVault, addrs.escrowVault, addrs.yesEscrow, addrs.noEscrow,
    addrs.orderBook, addrs.oracleFeed, addrs.usdcMint,
    MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId, SYSVAR_RENT_PUBKEY,
  ];

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey,
      authority: admin.publicKey,
      lookupTable: altAddress,
      addresses: addressesToAdd,
    })),
    [admin],
    { commitment: "confirmed" },
  );

  await sleep(500);

  const setAltDisc = anchorDiscriminator("set_market_alt");
  const setAltData = Buffer.concat([setAltDisc, altAddress.toBuffer()]);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(new TransactionInstruction({
      programId: MERIDIAN_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: addrs.configPda, isSigner: false, isWritable: false },
        { pubkey: addrs.marketPda, isSigner: false, isWritable: true },
      ],
      data: setAltData,
    })),
    [admin],
    { commitment: "confirmed" },
  );
}

// ---------------------------------------------------------------------------
// Seed liquidity helpers
// ---------------------------------------------------------------------------

function computeQuote(spotPrice: number, strikeDollars: number, marketCloseUnix: number) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const hoursToExpiry = Math.max(0.1, (marketCloseUnix - nowUnix) / 3600);
  const T = hoursToExpiry / 8760; // years
  const fairProb = binaryCallPrice(spotPrice, strikeDollars, DEFAULT_VOL, T);
  const quote = generateQuotes(fairProb, 0); // zero inventory
  return { fairProb, quote, fairCents: probToCents(fairProb) };
}

/** Ensure admin ATAs exist for a market's mints. */
async function ensureATAs(
  connection: Connection,
  admin: Keypair,
  addrs: MarketAddresses,
): Promise<void> {
  const adminUsdcAta = getAssociatedTokenAddressSync(addrs.usdcMint, admin.publicKey);
  const adminYesAta = getAssociatedTokenAddressSync(addrs.yesMint, admin.publicKey);
  const adminNoAta = getAssociatedTokenAddressSync(addrs.noMint, admin.publicKey);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminUsdcAta, admin.publicKey, addrs.usdcMint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminYesAta, admin.publicKey, addrs.yesMint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminNoAta, admin.publicKey, addrs.noMint));
  await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
}

function toScriptMarketAddrs(addrs: MarketAddresses) {
  return {
    market: addrs.marketPda,
    yesMint: addrs.yesMint,
    noMint: addrs.noMint,
    usdcVault: addrs.usdcVault,
    escrowVault: addrs.escrowVault,
    yesEscrow: addrs.yesEscrow,
    noEscrow: addrs.noEscrow,
    orderBook: addrs.orderBook,
    oracleFeed: addrs.oracleFeed,
  };
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
    console.error("ERROR: USDC_MINT not found in .env. Run create-mock-usdc.ts first.");
    process.exit(1);
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  console.log(`USDC Mint: ${usdcMint.toBase58()}`);

  // Load env vars for market data client (scripts don't auto-load .env into process.env)
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }

  // Fetch live prices from market data API
  const MAG7_PRICES: Record<string, number> = {};
  try {
    const client = createMarketDataClient();
    const quotes = await client.getQuotes(TICKERS);
    for (const q of quotes) {
      if (q.prevclose && q.prevclose > 0) {
        MAG7_PRICES[q.symbol] = q.prevclose;
        console.log(`  ${q.symbol}: prevclose=$${q.prevclose} (live from Yahoo Finance)`);
      }
    }
  } catch (err: any) {
    console.warn(`Market data API unavailable: ${err.message?.slice(0, 80)}`);
  }

  // Fill in any missing tickers with fallback prices
  for (const ticker of TICKERS) {
    if (!MAG7_PRICES[ticker]) {
      MAG7_PRICES[ticker] = MAG7_FALLBACK[ticker] ?? 200;
      console.log(`  ${ticker}: prevclose=$${MAG7_PRICES[ticker]} (fallback — API unavailable)`);
    }
  }

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PROGRAM_ID);
  const marketCloseUnix = todayMarketCloseUnix();
  const expiryDay = expiryDayFromUnix(marketCloseUnix);

  console.log(`Market close: ${new Date(marketCloseUnix * 1000).toISOString()}`);
  console.log(`Expiry day:   ${expiryDay}`);

  // Build full market list
  interface MarketSpec {
    ticker: string;
    strikeDollars: number;
    previousClose: number;
  }

  const specs: MarketSpec[] = [];
  for (const [ticker, price] of Object.entries(MAG7_PRICES)) {
    const strikes = generateStrikes(price);
    for (const strike of strikes) {
      specs.push({ ticker, strikeDollars: strike, previousClose: price });
    }
  }

  console.log(`\nWill create ${specs.length} markets across ${Object.keys(MAG7_PRICES).length} tickers:`);
  for (const [ticker, price] of Object.entries(MAG7_PRICES)) {
    const strikes = generateStrikes(price);
    console.log(`  ${ticker} ($${price}): strikes ${strikes.map((s) => `$${s}`).join(", ")}`);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  // ── Pass 1: Create markets ──────────────────────────────────────────────
  console.log(`\n── Pass 1: Creating markets ──`);
  interface MarketEntry {
    spec: MarketSpec;
    addrs: MarketAddresses;
    needsSeed: boolean;
  }
  const entries: MarketEntry[] = [];

  for (const spec of specs) {
    const strikeLamports = new BN(spec.strikeDollars * 1_000_000);
    const prevCloseLamports = new BN(spec.previousClose * 1_000_000);
    const addrs = deriveMarketPDAs(spec.ticker, strikeLamports, expiryDay, usdcMint, configPda);
    const label = `${spec.ticker} $${spec.strikeDollars}`;

    try {
      const existing = await connection.getAccountInfo(addrs.marketPda);
      if (!existing) {
        await createMarket(connection, admin, spec.ticker, strikeLamports, prevCloseLamports, marketCloseUnix, addrs);
        await createAndSetAlt(connection, admin, addrs);
        created++;
        console.log(`  [${created + skipped}/${specs.length}] Created: ${label}`);
      } else {
        skipped++;
      }

      // Check if seeding needed
      const obAccount = await connection.getAccountInfo(addrs.orderBook);
      const nextOrderIdOffset = 8 + 32; // discriminator + market pubkey
      const hasOrders = obAccount && obAccount.data.length > nextOrderIdOffset + 8
        && obAccount.data.readBigUInt64LE(nextOrderIdOffset) > BigInt(0);

      entries.push({ spec, addrs, needsSeed: !hasOrders });

      if (hasOrders) {
        console.log(`  [${created + skipped}/${specs.length}] Exists+seeded: ${label} (skipped)`);
      }
    } catch (err: any) {
      failed++;
      const logs = err?.logs ?? [];
      const progErr = logs.find((l: string) => l.includes("Error") || l.includes("failed"));
      console.error(`  FAILED: ${label} — ${err.message?.slice(0, 120)}`);
      if (progErr) console.error(`    Log: ${progErr}`);
    }
  }

  const toSeed = entries.filter((e) => e.needsSeed);
  if (toSeed.length === 0) {
    console.log(`\nAll markets already seeded.`);
  } else {
    const quoteLamports = QUOTE_QTY * 1_000_000;

    // ── Pass 2: Seed USDC bids (side=0) at multiple price levels ────────
    // Posts bids at fair-1, fair-2, fair-3 to create realistic depth
    console.log(`\n── Pass 2: Posting USDC bids (${SEED_LEVELS} levels) for ${toSeed.length} markets ──`);
    let bidCount = 0;

    for (const entry of toSeed) {
      const { spec, addrs } = entry;
      const label = `${spec.ticker} $${spec.strikeDollars}`;
      try {
        await ensureATAs(connection, admin, addrs);
        const { quote, fairCents } = computeQuote(spec.previousClose, spec.strikeDollars, marketCloseUnix);

        for (let lvl = 0; lvl < SEED_LEVELS; lvl++) {
          const bidPrice = Math.max(1, quote.bidPrice - lvl);
          // Taper quantity: full at best bid, 75% at next, 50% at third
          const lvlQty = Math.round(quoteLamports * (1 - lvl * 0.25));
          const bidIx = buildPlaceOrderIx(addrs.configPda, admin, toScriptMarketAddrs(addrs), addrs.usdcMint, 0, bidPrice, lvlQty, 1, 0);
          await sendAndConfirmTransaction(connection, new Transaction().add(bidIx), [admin], { commitment: "confirmed" });
        }

        bidCount++;
        console.log(`  [${bidCount}/${toSeed.length}] Bids: ${label}  (fair=${fairCents}c  best_bid=${quote.bidPrice}c  levels=${SEED_LEVELS})`);
      } catch (err: any) {
        console.error(`  Bid FAILED: ${label} — ${err.message?.slice(0, 120)}`);
      }
    }

    // ── Pass 3: Mint pairs + post Yes asks at multiple price levels ──────
    // Need enough tokens for SEED_LEVELS asks. Mint extra to cover.
    const totalAskTokens = SEED_LEVELS * quoteLamports;
    const mintLamports = totalAskTokens;
    console.log(`\n── Pass 3: Minting pairs + posting asks (${SEED_LEVELS} levels) for ${toSeed.length} markets ──`);
    let askCount = 0;

    for (const entry of toSeed) {
      const { spec, addrs } = entry;
      const label = `${spec.ticker} $${spec.strikeDollars}`;
      try {
        // Mint enough pairs for all ask levels
        const mintIx = buildMintPairIx(admin, {
          market: addrs.marketPda,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          usdcVault: addrs.usdcVault,
          configPda: addrs.configPda,
          usdcMint: addrs.usdcMint,
        }, mintLamports);
        await sendAndConfirmTransaction(connection, new Transaction().add(mintIx), [admin], { commitment: "confirmed" });

        // Post asks at fair+1, fair+2, fair+3
        const { quote, fairCents } = computeQuote(spec.previousClose, spec.strikeDollars, marketCloseUnix);
        for (let lvl = 0; lvl < SEED_LEVELS; lvl++) {
          const askPrice = Math.min(99, quote.askPrice + lvl);
          const lvlQty = Math.round(quoteLamports * (1 - lvl * 0.25));
          const askIx = buildPlaceOrderIx(addrs.configPda, admin, toScriptMarketAddrs(addrs), addrs.usdcMint, 1, askPrice, lvlQty, 1, 0);
          await sendAndConfirmTransaction(connection, new Transaction().add(askIx), [admin], { commitment: "confirmed" });
        }

        askCount++;
        console.log(`  [${askCount}/${toSeed.length}] Mint+Asks: ${label}  (fair=${fairCents}c  best_ask=${quote.askPrice}c  levels=${SEED_LEVELS})`);
      } catch (err: any) {
        console.error(`  Mint/Ask FAILED: ${label} — ${err.message?.slice(0, 120)}`);
        const logs = err?.logs ?? [];
        const progErr = logs.find((l: string) => l.includes("Error") || l.includes("failed"));
        if (progErr) console.error(`    Log: ${progErr}`);
      }
    }
  }

  console.log(`\n=== Test market creation complete ===`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped} (already existed)`);
  console.log(`  Seeded:  ${toSeed.length} (${SEED_LEVELS} bid levels + ${SEED_LEVELS} ask levels per market)`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Total:   ${specs.length}`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
