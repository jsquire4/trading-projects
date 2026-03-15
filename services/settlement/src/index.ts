// ---------------------------------------------------------------------------
// Settlement Service — one-shot job, triggered ~4:05 PM ET
//
// 1. Fetch closing prices from market data client
// 2. Update mock oracle price feeds
// 3. Settle all expired, unsettled markets (with oracle retry)
// 4. Crank cancel resting orders on settled markets
// 4.5 Auto-redeem winning tokens for settled markets past override deadline
// 5. Close eligible markets
// 6. Auto-create next-day markets
// 7. Log results + alert on failures
// ---------------------------------------------------------------------------

import http from "node:http";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { tickerFromBytes } from "../../shared/src/utils.js";
import meridianIdl from "../../shared/src/idl/meridian.json" with { type: "json" };
import mockOracleIdl from "../../shared/src/idl/mock_oracle.json" with { type: "json" };
import {
  findGlobalConfig,
  findPriceFeed,
  padTicker,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "../../shared/src/pda.js";

import { settleMarkets, MarketInfo } from "./settler.js";
import { crankCancelAll } from "./cranker.js";
import { autoRedeemAll } from "./redeemer.js";
import { closeEligibleMarkets } from "./closer.js";

const log = createLogger("settlement");

// ---------------------------------------------------------------------------
// Step 1: Fetch closing prices from market data API
// ---------------------------------------------------------------------------

async function fetchClosingPrices(
  marketData: IMarketDataClient,
  tickers: string[],
): Promise<Map<string, number>> {
  log.info(`Fetching closing prices for ${tickers.length} tickers`, {
    tickers,
  });

  const quotes = await marketData.getQuotes(tickers);
  const prices = new Map<string, number>();

  for (const q of quotes) {
    // Prefer prevclose (prior day's closing price) for settlement accuracy.
    // Fall back to last trade price if prevclose is unavailable (e.g. IPO day).
    const prevOk = q.prevclose != null && q.prevclose > 0;
    const lastOk = q.last > 0;
    if (!prevOk && !lastOk) {
      log.error(`${q.symbol}: both prevclose and last are zero/null — skipping`);
      continue;
    }
    const price = prevOk ? q.prevclose! : q.last;
    const source = prevOk ? "prevclose" : "last";
    prices.set(q.symbol, price);
    log.info(`${q.symbol}: $${price} (source: ${source})`);
  }

  // Check for tickers not returned by the API at all (zero-price skips already logged above)
  const returned = new Set(quotes.map((q) => q.symbol));
  const notReturned = tickers.filter((t) => !returned.has(t));
  if (notReturned.length > 0) {
    log.error(`Market data API returned no quote for: ${notReturned.join(", ")}. These tickers will be skipped.`);
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

  const failedTickers: string[] = [];

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
      failedTickers.push(ticker);
    }
  }

  // Remove failed tickers after iteration (don't mutate Map during iteration)
  for (const ticker of failedTickers) {
    prices.delete(ticker);
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
// Phase functions — each encapsulates one step of the settlement pipeline
// ---------------------------------------------------------------------------

/** Phase 3: Find and settle all expired, unsettled markets. */
async function settleExpiredMarkets(
  meridianProgram: Program,
  allMarkets: MarketInfo[],
  closingPrices: Map<string, number>,
): Promise<import("./settler.js").SettlementResult> {
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
  const result = await settleMarkets(meridianProgram, expiredUnsettled);
  log.info(
    `Settlement complete: ${result.settled.length} settled, ${result.failed.length} failed`,
  );
  return result;
}

/** Phase 4 + 4.5: Crank cancel resting orders and auto-redeem winners. */
async function crankAndRedeem(
  meridianProgram: Program,
  allMarkets: MarketInfo[],
  settlementResult: import("./settler.js").SettlementResult,
  usdcMint: PublicKey,
): Promise<void> {
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

    log.info(`Running auto-redeem on ${settledMarkets.length} settled markets`);
    const redeemResults = await autoRedeemAll(meridianProgram, settledMarkets, usdcMint);
    for (const r of redeemResults) {
      if (r.error) {
        log.error(`Auto-redeem failed for ${r.market}: ${r.error}`);
      } else if (r.redeemed > 0) {
        log.info(`Auto-redeemed ${r.redeemed} users for ${r.market} in ${r.batches} batches`);
      }
    }
  } else {
    log.info("No settled markets to crank or auto-redeem");
  }
}

/** Phase 5: Close markets that have been settled long enough. */
async function closeMarkets(
  meridianProgram: Program,
  adminKeypair: Keypair,
  connection: Connection,
): Promise<void> {
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
}

/** Phase 6: Spawn market-initializer as a child process to create next-day markets. */
async function initNextDay(): Promise<void> {
  log.info("Creating markets for next trading day");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const initScript = resolve(__dirname, "../../market-initializer/src/index.ts");
  const tsxPath = resolve(__dirname, "../../node_modules/.bin/tsx");

  try {
    await new Promise<void>((resolveP, rejectP) => {
      const child = execFile(tsxPath, [initScript], {
        env: { ...process.env },
        timeout: 5 * 60 * 1000, // 5 minute timeout
      }, (err, stdout, stderr) => {
        if (stdout) {
          for (const line of stdout.split("\n").filter(Boolean)) {
            log.info(`[market-initializer] ${line}`);
          }
        }
        if (stderr) {
          for (const line of stderr.split("\n").filter(Boolean)) {
            log.warn(`[market-initializer:stderr] ${line}`);
          }
        }
        if (err) {
          rejectP(err);
        } else {
          resolveP();
        }
      });
    });
    log.info("Next-day market initialization completed");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to create next-day markets: ${errMsg}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Non-fatal — settlement was successful, markets can be created by morning-init
  }
}

// ---------------------------------------------------------------------------
// Settlement cycle — orchestrates all phases
// ---------------------------------------------------------------------------

async function runSettlementCycle(): Promise<{ ok: boolean; error?: string; summary?: Record<string, unknown> }> {
  const startTime = Date.now();

  const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const ADMIN_KEYPAIR_B58 = process.env.ADMIN_KEYPAIR;

  if (!ADMIN_KEYPAIR_B58) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

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

  const marketData = createMarketDataClient();

  // ---- Load on-chain state ----
  const [configPda] = findGlobalConfig();
  const globalConfig = await meridianProgram.account.globalConfig.fetch(configPda);
  const usdcMint = globalConfig.usdcMint as PublicKey;

  // Extract active tickers from GlobalConfig
  const tickerCount = (globalConfig.tickerCount as number) ?? 0;
  const tickerArrays = globalConfig.tickers as number[][];
  const activeTickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const t = tickerFromBytes(tickerArrays[i]);
    if (t.length > 0) activeTickers.push(t);
  }

  if (activeTickers.length === 0) {
    return { ok: true, summary: { message: "No active tickers found" } };
  }

  log.info(`Active tickers: ${activeTickers.join(", ")}`);

  // ---- Phase 1: Fetch closing prices ----
  const closingPrices = await fetchClosingPrices(marketData, activeTickers);

  // ---- Phase 2: Update oracle feeds ----
  await updateOracleFeeds(oracleProgram, adminKeypair, closingPrices);

  // ---- Phase 3: Settle expired markets ----
  const allMarkets = await loadUnsettledMarkets(meridianProgram);
  const settlementResult = await settleExpiredMarkets(meridianProgram, allMarkets, closingPrices);

  // ---- Phase 4 + 4.5: Crank cancel + auto-redeem ----
  await crankAndRedeem(meridianProgram, allMarkets, settlementResult, usdcMint);

  // ---- Phase 5: Close eligible markets ----
  await closeMarkets(meridianProgram, adminKeypair, connection);

  // ---- Phase 6: Create next-day markets (child process) ----
  await initNextDay();

  // ---- Summary ----
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
    return { ok: false, error: `${settlementResult.failed.length} settlement failures`, summary };
  }

  log.info(`Settlement completed successfully in ${elapsed}s`, summary);
  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// Synthetic mode: HTTP trigger server
// ---------------------------------------------------------------------------

function startTriggerServer(): void {
  const port = parseInt(process.env.TRIGGER_PORT ?? "4002", 10);
  let running = false;

  const triggerToken = process.env.SETTLEMENT_TRIGGER_TOKEN ?? "";

  const server = http.createServer(async (req, res) => {
    if (req.url !== "/trigger") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed — use POST" }));
      return;
    }

    // Require a shared secret when SETTLEMENT_TRIGGER_TOKEN is set
    if (triggerToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${triggerToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (running) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Settlement cycle already in progress" }));
      return;
    }

    running = true;
    try {
      const result = await runSettlementCycle();
      const status = result.ok ? 200 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Trigger settlement cycle failed", { error: msg });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    } finally {
      running = false;
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log.info(`Settlement trigger server listening on 127.0.0.1:${port} (POST /trigger)`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isSynthetic = process.env.MARKET_DATA_SOURCE === "synthetic";

  if (isSynthetic) {
    log.info("=== Settlement Service starting in SYNTHETIC mode — trigger server ===");
    startTriggerServer();
    return; // Keep process alive (HTTP server)
  }

  // Live mode: one-shot
  log.info("=== Settlement Service starting (live mode) ===");
  try {
    const result = await runSettlementCycle();
    if (!result.ok) {
      process.exit(1);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.critical(`Settlement service crashed: ${errMsg}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  log.critical("Fatal error in settlement service", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
