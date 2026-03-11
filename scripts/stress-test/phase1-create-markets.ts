/**
 * phase1-create-markets.ts — Create 21 markets (7 tickers × 3 strikes),
 * including oracle feeds, order book allocation, ALT setup.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  AddressLookupTableProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  MARKET_DEFS,
  DEFAULTS,
  type PhaseStats,
  newPhaseStats,
  finishPhaseStats,
} from "./config";
import {
  deriveMarketAddresses,
  findGlobalConfig,
  findPriceFeed,
  sendTx,
  batch,
  type MarketAddresses,
  MERIDIAN_PROGRAM_ID,
} from "./helpers";
import {
  buildInitializeFeedIx,
  buildUpdatePriceIx,
  buildAllocateOrderBookIx,
  buildCreateStrikeMarketIx,
  buildSetMarketAltIx,
  MOCK_ORACLE_PROGRAM_ID,
  padTicker,
} from "./instructions";
import { TICKERS, SETTLEMENT_PRICES, type Ticker } from "./config";

const ORDER_BOOK_TOTAL_SPACE = 8 + 127_560; // 127,568 bytes
const MAX_GROWTH = 10_240;
const ALLOC_BATCH_SIZE = 6; // instructions per tx

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensure all 7 oracle feeds exist and have fresh prices.
 */
async function ensureOracleFeeds(
  connection: Connection,
  admin: Keypair,
  stats: PhaseStats,
): Promise<void> {
  const [configPda] = findGlobalConfig();

  for (const ticker of TICKERS) {
    const [feedPda] = findPriceFeed(ticker);
    const existing = await connection.getAccountInfo(feedPda);

    if (!existing) {
      // Initialize the feed
      stats.attempted++;
      try {
        const ix = buildInitializeFeedIx({
          authority: admin.publicKey,
          priceFeed: feedPda,
          ticker,
        });
        await sendTx(connection, new Transaction().add(ix), [admin]);
        stats.succeeded++;
        console.log(`  Oracle feed initialized: ${ticker}`);
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`init_feed ${ticker}: ${e.message?.slice(0, 120)}`);
        console.error(`  ERROR init feed ${ticker}: ${e.message?.slice(0, 80)}`);
      }
    }

    // Update price to a recent value so settle_market can use it
    stats.attempted++;
    try {
      const price = SETTLEMENT_PRICES[ticker as Ticker] ?? 200_000_000n;
      const now = Math.floor(Date.now() / 1000) - 2;
      const ix = buildUpdatePriceIx({
        authority: admin.publicKey,
        priceFeed: feedPda,
        price: new BN(price.toString()),
        confidence: new BN(Math.floor(Number(price) * 40 / 10_000)),  // 0.4% of price (under 0.5% cap)
        timestamp: new BN(now),
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`update_price ${ticker}: ${e.message?.slice(0, 120)}`);
    }
  }
}

/**
 * Allocate order book PDA to full size (127,568 bytes).
 */
async function allocateOrderBook(
  connection: Connection,
  admin: Keypair,
  orderBook: PublicKey,
  marketKey: PublicKey,
  stats: PhaseStats,
): Promise<void> {
  const existing = await connection.getAccountInfo(orderBook);
  const currentLen = existing?.data.length ?? 0;
  if (currentLen >= ORDER_BOOK_TOTAL_SPACE) return;

  const remainingCalls = Math.ceil((ORDER_BOOK_TOTAL_SPACE - currentLen) / MAX_GROWTH);
  const allocIx = buildAllocateOrderBookIx({
    payer: admin.publicKey,
    orderBook,
    marketKey,
  });

  for (let i = 0; i < remainingCalls; i += ALLOC_BATCH_SIZE) {
    const batchCount = Math.min(ALLOC_BATCH_SIZE, remainingCalls - i);
    const tx = new Transaction();
    for (let j = 0; j < batchCount; j++) tx.add(allocIx);

    stats.attempted++;
    try {
      await sendTx(connection, tx, [admin]);
      stats.succeeded++;
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`alloc_ob: ${e.message?.slice(0, 120)}`);
    }
  }
}

/**
 * Create a single market and set up its ALT.
 */
async function createSingleMarket(
  connection: Connection,
  admin: Keypair,
  usdcMint: PublicKey,
  m: MarketAddresses,
  marketCloseUnix: number,
  expiryDay: number,
  stats: PhaseStats,
): Promise<void> {
  const [configPda] = findGlobalConfig();

  // Check if market already exists
  const existing = await connection.getAccountInfo(m.market);
  if (existing) {
    console.log(`  Market ${m.def.ticker} $${Number(m.def.strikeLamports) / 1_000_000} already exists`);
    return;
  }

  // 1. Allocate order book
  await allocateOrderBook(connection, admin, m.orderBook, m.market, stats);

  // 2. Create strike market
  stats.attempted++;
  try {
    const ix = buildCreateStrikeMarketIx({
      admin: admin.publicKey,
      config: configPda,
      market: m.market,
      yesMint: m.yesMint,
      noMint: m.noMint,
      usdcVault: m.usdcVault,
      escrowVault: m.escrowVault,
      yesEscrow: m.yesEscrow,
      noEscrow: m.noEscrow,
      orderBook: m.orderBook,
      oracleFeed: m.oracleFeed,
      usdcMint,
      ticker: padTicker(m.def.ticker),
      strikePrice: new BN(m.def.strikeLamports.toString()),
      expiryDay,
      marketCloseUnix: new BN(marketCloseUnix),
      previousClose: new BN(m.def.previousCloseLamports.toString()),
    });
    await sendTx(connection, new Transaction().add(ix), [admin]);
    stats.succeeded++;
    console.log(`  Created: ${m.def.ticker} $${Number(m.def.strikeLamports) / 1_000_000} ${m.def.isLifecycle ? "(lifecycle)" : "(trading)"}`);
  } catch (e: any) {
    stats.failed++;
    stats.errors.push(`create_market ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
    console.error(`  ERROR create ${m.def.ticker}: ${e.message?.slice(0, 80)}`);
    return; // Skip ALT if market creation failed
  }

  // 3. Create and set ALT
  await createAndSetAlt(connection, admin, configPda, m, usdcMint, stats);
}

/**
 * Create an Address Lookup Table and call set_market_alt.
 */
async function createAndSetAlt(
  connection: Connection,
  admin: Keypair,
  configPda: PublicKey,
  m: MarketAddresses,
  usdcMint: PublicKey,
  stats: PhaseStats,
): Promise<void> {
  // Warmup tx to get a valid recent slot
  stats.attempted++;
  try {
    const warmupSig = await sendTx(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: admin.publicKey,
          lamports: 1,
        }),
      ),
      [admin],
    );
    const warmupTx = await connection.getTransaction(warmupSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const slot = warmupTx?.slot ?? (await connection.getSlot("confirmed"));
    stats.succeeded++;

    // Create ALT
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey,
      payer: admin.publicKey,
      recentSlot: slot,
    });

    stats.attempted++;
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(createIx),
      [admin],
      { commitment: "confirmed", skipPreflight: true },
    );
    stats.succeeded++;

    // Extend ALT
    const addresses = [
      configPda, m.market, m.yesMint, m.noMint,
      m.usdcVault, m.escrowVault, m.yesEscrow, m.noEscrow,
      m.orderBook, m.oracleFeed, usdcMint,
      MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId, SYSVAR_RENT_PUBKEY,
    ];

    stats.attempted++;
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey,
      authority: admin.publicKey,
      lookupTable: altAddress,
      addresses,
    });
    await sendTx(connection, new Transaction().add(extendIx), [admin]);
    stats.succeeded++;

    // Wait for ALT activation
    await sleep(500);

    // Set market ALT
    stats.attempted++;
    const setAltIx = buildSetMarketAltIx({
      admin: admin.publicKey,
      config: configPda,
      market: m.market,
      altAddress,
    });
    await sendTx(connection, new Transaction().add(setAltIx), [admin]);
    stats.succeeded++;
  } catch (e: any) {
    stats.failed++;
    stats.errors.push(`alt ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
    console.error(`  ERROR ALT ${m.def.ticker}: ${e.message?.slice(0, 80)}`);
  }
}

/**
 * Phase 1: Create all 21 markets with oracle feeds and ALTs.
 * Returns the derived market addresses for all markets.
 */
export async function phase1CreateMarkets(
  connection: Connection,
  admin: Keypair,
  usdcMint: PublicKey,
  runId: number,
  marketCloseUnixLifecycle: number,
  marketCloseUnixTrading: number,
): Promise<{ stats: PhaseStats; markets: MarketAddresses[] }> {
  console.log("\n[Phase 1] Creating 21 markets (7 tickers × 3 strikes)...");
  const stats = newPhaseStats("Create Markets");

  // Ensure oracle feeds exist and have fresh prices
  await ensureOracleFeeds(connection, admin, stats);

  // Derive all market addresses
  const markets: MarketAddresses[] = MARKET_DEFS.map((def) => {
    const closeUnix = def.isLifecycle ? marketCloseUnixLifecycle : marketCloseUnixTrading;
    return deriveMarketAddresses(def, closeUnix);
  });

  // Create markets in batches
  const batches = batch(markets, DEFAULTS.MARKET_CREATION_BATCH_SIZE);
  for (let bi = 0; bi < batches.length; bi++) {
    const marketBatch = batches[bi];
    console.log(`  Batch ${bi + 1}/${batches.length} (${marketBatch.length} markets)...`);

    // Process each market in the batch sequentially (ALT requires sequential steps)
    // but different batches can't easily be parallelized due to admin nonce
    for (const m of marketBatch) {
      const closeUnix = m.def.isLifecycle ? marketCloseUnixLifecycle : marketCloseUnixTrading;
      const expiryDay = Math.floor(closeUnix / 86400);
      await createSingleMarket(connection, admin, usdcMint, m, closeUnix, expiryDay, stats);
    }
  }

  // Verify all markets created
  let verified = 0;
  for (const m of markets) {
    const acct = await connection.getAccountInfo(m.market);
    if (acct) verified++;
  }
  console.log(`  Verification: ${verified}/${markets.length} markets exist on-chain`);

  return { stats: finishPhaseStats(stats), markets };
}
