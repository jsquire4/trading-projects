// ---------------------------------------------------------------------------
// Settlement Service — one-shot job, triggered ~4:05 PM ET
//
// 1. Fetch closing prices from Tradier
// 2. Update mock oracle price feeds
// 3. Settle all expired, unsettled markets (with oracle retry)
// 4. Crank cancel resting orders on settled markets
// 5. Log results + alert on failures
// ---------------------------------------------------------------------------

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { TradierClient } from "../../shared/src/tradier-client.js";
import { createLogger } from "../../shared/src/alerting.js";
import meridianIdl from "../../shared/src/idl/meridian.json" with { type: "json" };
import mockOracleIdl from "../../shared/src/idl/mock_oracle.json" with { type: "json" };
import {
  findGlobalConfig,
  findPriceFeed,
  padTicker,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "../../shared/src/pda.js";

import { settleMarkets, MarketInfo, tickerFromBytes } from "./settler.js";
import { crankCancelAll } from "./cranker.js";
import { closeEligibleMarkets } from "./closer.js";

const log = createLogger("settlement");

// ---------------------------------------------------------------------------
// Step 1: Fetch closing prices from Tradier
// ---------------------------------------------------------------------------

async function fetchClosingPrices(
  tradier: TradierClient,
  tickers: string[],
): Promise<Map<string, number>> {
  log.info(`Fetching closing prices for ${tickers.length} tickers`, {
    tickers,
  });

  const quotes = await tradier.getQuotes(tickers);
  const prices = new Map<string, number>();

  for (const q of quotes) {
    // Use `last` as the closing price (market just closed)
    prices.set(q.symbol, q.last);
    log.info(`${q.symbol}: $${q.last}`);
  }

  const missing = tickers.filter((t) => !prices.has(t));
  if (missing.length > 0) {
    log.error(`No closing price returned for: ${missing.join(", ")}. These tickers will be skipped.`);
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Step 2: Update oracle price feeds
// ---------------------------------------------------------------------------

async function updateOracleFeeds(
  oracleProgram: Program,
  adminKeypair: Keypair,
  prices: Map<string, number>,
): Promise<void> {
  log.info("Updating oracle price feeds");
  const now = Math.floor(Date.now() / 1000);

  const ORACLE_MAX_RETRIES = 3;
  const ORACLE_RETRY_DELAY_MS = 2_000;

  for (const [ticker, price] of prices) {
    const [priceFeedPda] = findPriceFeed(ticker);

    // Price in USDC lamports: $200.50 -> 200_500_000 (6 decimals)
    const priceLamports = new BN(Math.round(price * 1_000_000));
    // Confidence band: 0.1% of price in lamports
    const confidence = new BN(Math.max(1, Math.round(price * 1_000)));
    const timestamp = new BN(now);

    let succeeded = false;
    for (let attempt = 1; attempt <= ORACLE_MAX_RETRIES; attempt++) {
      try {
        await oracleProgram.methods
          .updatePrice(priceLamports, confidence, timestamp)
          .accounts({
            authority: adminKeypair.publicKey,
            priceFeed: priceFeedPda,
          })
          .rpc();

        log.info(`Updated oracle for ${ticker}: ${priceLamports.toString()} lamports`, {
          ticker,
          price,
          priceLamports: priceLamports.toString(),
          confidence: confidence.toString(),
        });
        succeeded = true;
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt < ORACLE_MAX_RETRIES) {
          log.warn(`Oracle update for ${ticker} failed (attempt ${attempt}/${ORACLE_MAX_RETRIES}), retrying`, {
            error: errMsg,
          });
          await new Promise((r) => setTimeout(r, ORACLE_RETRY_DELAY_MS * attempt));
        } else {
          log.error(`Failed to update oracle for ${ticker} after ${ORACLE_MAX_RETRIES} attempts`, {
            ticker,
            priceFeed: priceFeedPda.toBase58(),
            error: errMsg,
          });
        }
      }
    }

    if (!succeeded) {
      prices.delete(ticker);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 + 4: Load markets, settle, crank
// ---------------------------------------------------------------------------

async function loadUnsettledMarkets(
  meridianProgram: Program,
): Promise<MarketInfo[]> {
  log.info("Loading all StrikeMarket accounts");

  // Fetch all StrikeMarket program accounts
  const allMarkets = await meridianProgram.account.strikeMarket.all();

  log.info(`Found ${allMarkets.length} total markets`);

  // Map to our MarketInfo shape
  return allMarkets.map((m) => ({
    publicKey: m.publicKey,
    account: {
      config: m.account.config as PublicKey,
      ticker: m.account.ticker as number[],
      strikePrice: m.account.strikePrice as BN,
      marketCloseUnix: m.account.marketCloseUnix as BN,
      isSettled: m.account.isSettled as boolean,
      oracleFeed: m.account.oracleFeed as PublicKey,
      orderBook: m.account.orderBook as PublicKey,
      escrowVault: m.account.escrowVault as PublicKey,
      yesEscrow: m.account.yesEscrow as PublicKey,
      noEscrow: m.account.noEscrow as PublicKey,
      yesMint: m.account.yesMint as PublicKey,
      noMint: m.account.noMint as PublicKey,
      usdcVault: m.account.usdcVault as PublicKey,
    },
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("=== Settlement Service starting ===");
  const startTime = Date.now();

  // ---- Environment ----------------------------------------------------------
  const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const ADMIN_KEYPAIR_B58 = process.env.ADMIN_KEYPAIR;

  if (!ADMIN_KEYPAIR_B58) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

  // ---- Setup ----------------------------------------------------------------
  const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_KEYPAIR_B58));
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meridianProgram = new Program(meridianIdl as any, provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oracleProgram = new Program(mockOracleIdl as any, provider);

  const tradier = new TradierClient();

  try {
    // ---- Load on-chain state ----
    const [configPda] = findGlobalConfig();
    const globalConfig = await meridianProgram.account.globalConfig.fetch(configPda);
    const usdcMint = globalConfig.usdcMint as PublicKey;

    // Extract active tickers from GlobalConfig
    const tickerCount = (globalConfig.tickerCount as number) ?? 0;
    const tickerArrays = globalConfig.tickers as number[][];
    const activeTickers: string[] = [];
    for (let i = 0; i < tickerCount; i++) {
      const t = Buffer.from(tickerArrays[i]).toString("utf-8").replace(/\0+$/, "");
      if (t.length > 0) activeTickers.push(t);
    }

    if (activeTickers.length === 0) {
      log.warn("No active tickers found in GlobalConfig, nothing to settle");
      return;
    }

    log.info(`Active tickers: ${activeTickers.join(", ")}`);

    // ---- Step 1: Fetch closing prices ----
    const closingPrices = await fetchClosingPrices(tradier, activeTickers);

    // ---- Step 2: Update oracle feeds ----
    await updateOracleFeeds(oracleProgram, adminKeypair, closingPrices);

    // ---- Step 3: Settle markets ----
    const allMarkets = await loadUnsettledMarkets(meridianProgram);
    const now = Math.floor(Date.now() / 1000);
    const expiredUnsettled = allMarkets.filter((m) => {
      if (m.account.isSettled) return false;
      if (m.account.marketCloseUnix.toNumber() > now) return false;
      const ticker = tickerFromBytes(m.account.ticker);
      if (!closingPrices.has(ticker)) {
        log.warn(`Skipping settlement for ${ticker} — no closing price available`);
        return false;
      }
      return true;
    });

    log.info(`${expiredUnsettled.length} markets eligible for settlement`);

    const settlementResult = await settleMarkets(meridianProgram, expiredUnsettled);

    log.info(
      `Settlement complete: ${settlementResult.settled.length} settled, ${settlementResult.failed.length} failed`,
    );

    // ---- Step 4: Crank cancel on settled markets ----
    // Include both freshly-settled and previously-settled markets
    const settledMarkets = allMarkets.filter(
      (m) =>
        m.account.isSettled ||
        settlementResult.settled.some((s) => s.publicKey.equals(m.publicKey)),
    );

    if (settledMarkets.length > 0) {
      log.info(`Running crank cancel on ${settledMarkets.length} settled markets`);
      const crankResults = await crankCancelAll(meridianProgram, settledMarkets, usdcMint);

      for (const r of crankResults) {
        if (r.error) {
          log.error(`Crank failed for ${r.market}: ${r.error}`);
        } else if (r.cancelled > 0) {
          log.info(`Cranked ${r.cancelled} orders for ${r.market}`);
        }
      }
    } else {
      log.info("No settled markets to crank");
    }

    // ---- Step 5: Close eligible markets ----
    log.info("Checking for markets eligible to close");
    const closeResult = await closeEligibleMarkets(meridianProgram, adminKeypair, connection);
    if (closeResult.closed.length > 0) {
      log.info(`Closed ${closeResult.closed.length} markets: ${closeResult.closed.join(", ")}`);
    }
    if (closeResult.failed.length > 0) {
      log.error(`Failed to close ${closeResult.failed.length} markets`, {
        failed: closeResult.failed,
      });
    }

    // ---- Step 6: Summary ----
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = {
      elapsed: `${elapsed}s`,
      settled: settlementResult.settled.map((m) => tickerFromBytes(m.account.ticker)),
      failed: settlementResult.failed.map((f) => ({
        ticker: tickerFromBytes(f.market.account.ticker),
        error: f.error,
      })),
    };

    if (settlementResult.failed.length > 0) {
      log.critical(
        `Settlement completed with ${settlementResult.failed.length} failures — manual override may be required`,
        summary,
      );
    } else {
      log.info(`Settlement completed successfully in ${elapsed}s`, summary);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.critical(`Settlement service crashed: ${errMsg}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }
}

main();
