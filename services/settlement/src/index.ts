// ---------------------------------------------------------------------------
// Settlement Service — long-running reactive poller
//
// Polls on-chain every 60s for expired, unsettled markets. When found:
//   1. Confirm Yahoo marketState is POST or CLOSED
//   2. Double-confirm closing prices (two polls 5 min apart must match)
//   3. Update mock oracle price feeds (per-ticker as confirmed)
//   4. Settle confirmed markets
//   5. Crank cancel resting orders on settled markets
//   5.5 Auto-redeem winning tokens for settled markets past override deadline
//   6. Close eligible markets
//   7. Trigger market-initializer to create next-day markets (via HTTP)
//   8. Unpause (autonomous retry)
//
// Also exposes an HTTP trigger server for manual/scheduler-triggered settlement.
// ---------------------------------------------------------------------------

import http from "node:http";
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

import { settleMarkets, adminSettleMarkets, MarketInfo } from "./settler.js";
import { crankCancelAll } from "./cranker.js";
import { autoRedeemAll } from "./redeemer.js";
import { closeEligibleMarkets } from "./closer.js";

const log = createLogger("settlement");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll for expired markets (ms) */
const POLL_INTERVAL_MS = 60_000;

/** Time between price confirmation polls (ms).
 *  30 seconds — fast enough to settle quickly after close, but Yahoo's
 *  unofficial API handles ~100-200 req/min. At 7 tickers per poll,
 *  30s interval = 14 req/min — well within limits. */
const PRICE_CONFIRM_INTERVAL_MS = 30_000;

/** Maximum time to wait for price confirmation before admin_settle fallback (ms) */
const PRICE_CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

/** Max retries for unpause on RPC failure */
const UNPAUSE_MAX_RETRIES = 5;

/** Base delay for unpause retry backoff (ms) */
const UNPAUSE_BASE_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Step 1: Confirm market is actually closed via Yahoo
// ---------------------------------------------------------------------------

async function confirmMarketClosed(marketData: IMarketDataClient): Promise<boolean> {
  // Check admin override first
  const override = getMarketStateOverride();
  if (override !== "auto") {
    const isClosed = override === "postmarket" || override === "closed";
    log.info(`Market state override active: "${override}" → ${isClosed ? "proceeding" : "waiting"}`);
    return isClosed;
  }

  try {
    const clock = await marketData.getMarketClock();
    const state = clock.state.toLowerCase();
    if (state === "postmarket" || state === "closed") {
      return true;
    }
    log.warn(`Yahoo marketState is "${clock.state}" — market may still be open, waiting`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to check market state via Yahoo: ${msg} — proceeding cautiously`);
    // If Yahoo is unreachable, proceed anyway — on-chain market_close_unix is authoritative
    return true;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Double-confirm closing prices
// ---------------------------------------------------------------------------

interface PriceConfirmation {
  /** Tickers with confirmed (stable) prices */
  confirmed: Map<string, number>;
  /** Tickers that timed out without confirming */
  timedOut: string[];
  /** Last known prices for all tickers (for admin_settle fallback) */
  lastKnownPrices?: Map<string, number>;
}

/**
 * Double-confirm closing prices: poll twice with a gap, settle each ticker
 * as soon as its price stabilizes across two consecutive polls.
 */
async function doubleConfirmPrices(
  marketData: IMarketDataClient,
  tickers: string[],
): Promise<PriceConfirmation> {
  const confirmed = new Map<string, number>();
  const remaining = new Set(tickers);
  let previousPrices = new Map<string, number>();
  const startTime = Date.now();

  log.info(`Double-confirm: starting price confirmation for ${tickers.length} tickers`, { tickers });

  // First poll
  const firstQuotes = await marketData.getQuotes([...remaining]);
  for (const q of firstQuotes) {
    const price = q.prevclose ?? q.last;
    if (price > 0) {
      previousPrices.set(q.symbol, price);
    }
  }

  log.info(`Double-confirm: first poll complete`, {
    prices: Object.fromEntries(previousPrices),
  });

  // Polling loop
  while (remaining.size > 0) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= PRICE_CONFIRM_TIMEOUT_MS) {
      log.error(`Double-confirm: timeout after ${Math.round(elapsed / 1000)}s — ${remaining.size} tickers unconfirmed`, {
        timedOut: [...remaining],
      });
      break;
    }

    // Wait before next poll
    log.info(`Double-confirm: waiting ${PRICE_CONFIRM_INTERVAL_MS / 1000}s before next poll (${remaining.size} remaining)`);
    await sleep(PRICE_CONFIRM_INTERVAL_MS);

    // Next poll (with retry on transient failure)
    let quotes: Awaited<ReturnType<typeof marketData.getQuotes>>;
    try {
      quotes = await marketData.getQuotes([...remaining]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Double-confirm: getQuotes failed, will retry next cycle: ${msg}`);
      continue; // Skip this poll, retry after next sleep
    }
    const currentPrices = new Map<string, number>();
    for (const q of quotes) {
      const price = q.prevclose ?? q.last;
      if (price > 0) {
        currentPrices.set(q.symbol, price);
      }
    }

    // Compare to previous poll — confirm tickers with matching prices
    for (const ticker of [...remaining]) {
      const prev = previousPrices.get(ticker);
      const curr = currentPrices.get(ticker);

      if (prev !== undefined && curr !== undefined && prev === curr) {
        confirmed.set(ticker, curr);
        remaining.delete(ticker);
        log.info(`Double-confirm: ${ticker} confirmed at $${(curr / 1).toFixed(2)}`, {
          ticker,
          price: curr,
          elapsedMs: Date.now() - startTime,
        });
      } else if (prev !== undefined && curr !== undefined && prev !== curr) {
        log.warn(`Double-confirm: ${ticker} price changed ($${prev} → $${curr}), resetting`, {
          ticker,
          prevPrice: prev,
          currPrice: curr,
        });
      }
    }

    // Current becomes previous for next iteration
    previousPrices = currentPrices;
  }

  return {
    confirmed,
    timedOut: [...remaining],
    lastKnownPrices: previousPrices,
  };
}

// ---------------------------------------------------------------------------
// Step 3: Update oracle price feeds
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
          await sleep(ORACLE_RETRY_DELAY_MS * attempt);
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

  // Log failed tickers (don't mutate the caller's map — SH-4)
  if (failedTickers.length > 0) {
    log.error(`Failed to update oracle for ${failedTickers.length} tickers: ${failedTickers.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Load and filter markets
// ---------------------------------------------------------------------------

async function loadAllMarkets(
  meridianProgram: Program,
): Promise<MarketInfo[]> {
  const allMarkets = await meridianProgram.account.strikeMarket.all();

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

function findExpiredUnsettled(markets: MarketInfo[], nowUnix: number): MarketInfo[] {
  return markets.filter((m) => {
    if (m.account.isSettled) return false;
    return m.account.marketCloseUnix.toNumber() <= nowUnix;
  });
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

/** Phase 3: Settle expired markets using confirmed prices. */
async function settleExpiredMarkets(
  meridianProgram: Program,
  allMarkets: MarketInfo[],
  confirmedPrices: Map<string, number>,
): Promise<import("./settler.js").SettlementResult> {
  const now = Math.floor(Date.now() / 1000);
  const expiredUnsettled = allMarkets.filter((m) => {
    if (m.account.isSettled) return false;
    if (m.account.marketCloseUnix.toNumber() > now) return false;
    const ticker = tickerFromBytes(m.account.ticker);
    if (!confirmedPrices.has(ticker)) {
      log.warn(`Skipping settlement for ${ticker} — price not confirmed`);
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

/** Phase 6: Trigger market-initializer to create next-day markets via HTTP. */
async function initNextDay(): Promise<void> {
  log.info("Creating markets for next trading day");

  const marketInitUrl = process.env.MARKET_INIT_URL ?? "http://127.0.0.1:4001";

  try {
    const res = await fetch(`${marketInitUrl}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 minute timeout
    });

    const body = await res.text();

    if (res.ok) {
      log.info(`Next-day market initialization completed: ${body}`);
    } else if (res.status === 409) {
      log.info("Market initialization already in progress — skipping");
    } else {
      log.error(`Market initialization failed (HTTP ${res.status}): ${body}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to reach market-initializer: ${errMsg}`);
    // Non-fatal — settlement was successful, markets can be created by health check
  }
}

/** Phase 7: Unpause with autonomous retry + exponential backoff. */
async function unpauseWithRetry(meridianProgram: Program, adminKeypair: Keypair): Promise<void> {
  const [configPda] = findGlobalConfig();

  for (let attempt = 1; attempt <= UNPAUSE_MAX_RETRIES; attempt++) {
    try {
      await meridianProgram.methods
        .unpause()
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
        })
        .rpc();

      log.info("Platform unpaused — new markets live, trading resumes");
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // NotPaused (6024) means circuit breaker was never tripped — normal close, nothing to do
      if (errMsg.includes("NotPaused") || errMsg.includes("6024")) {
        log.info("Platform was not paused (normal close) — no unpause needed");
        return;
      }

      if (attempt < UNPAUSE_MAX_RETRIES) {
        const delay = UNPAUSE_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn(`Unpause attempt ${attempt}/${UNPAUSE_MAX_RETRIES} failed, retrying in ${delay}ms`, {
          error: errMsg,
        });
        await sleep(delay);
      } else {
        log.critical(`Unpause failed after ${UNPAUSE_MAX_RETRIES} attempts — alerting`, {
          error: errMsg,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Settlement cycle — orchestrates all phases
// ---------------------------------------------------------------------------

/**
 * Run one full settlement cycle.
 *
 * Accepts pre-built `connection` and `adminKeypair` so that the polling loop
 * (which already constructs these once at startup) can pass them in rather
 * than recreating them on every cycle. When called from the HTTP trigger
 * server (which has no pre-built connection), pass `null` to fall back to
 * reading env vars.
 */
async function runSettlementCycle(
  sharedConnection?: Connection | null,
  sharedKeypair?: Keypair | null,
): Promise<{ ok: boolean; error?: string; summary?: Record<string, unknown> }> {
  const startTime = Date.now();

  let adminKeypair: Keypair;
  let connection: Connection;

  if (sharedConnection && sharedKeypair) {
    // Re-use pre-built instances from the polling loop to avoid recreating
    // Connection (WebSocket) and decoding the keypair on every cycle.
    connection = sharedConnection;
    adminKeypair = sharedKeypair;
  } else {
    const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
    const ADMIN_KEYPAIR_B58 = process.env.ADMIN_KEYPAIR;
    if (!ADMIN_KEYPAIR_B58) {
      throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
    }
    adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_KEYPAIR_B58));
    connection = new Connection(RPC_URL, "confirmed");
  }

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

  // ---- Phase 1: Confirm market is actually closed ----
  // Load markets first to check how stale the oldest expired market is.
  // If any market expired more than 2 hours ago, it's from a previous trading
  // day — skip the Yahoo market-state check and settle immediately. The Yahoo
  // check only guards against settling same-day markets while the market is
  // still open.
  const allMarketsPreCheck = await loadAllMarkets(meridianProgram);
  const nowUnix = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD_S = 2 * 60 * 60; // 2 hours
  const oldestExpiredAge = allMarketsPreCheck
    .filter((m) => !m.account.isSettled && m.account.marketCloseUnix.toNumber() <= nowUnix)
    .reduce((max, m) => Math.max(max, nowUnix - m.account.marketCloseUnix.toNumber()), 0);

  if (oldestExpiredAge > STALE_THRESHOLD_S) {
    log.info(`Stale markets detected (oldest expired ${Math.round(oldestExpiredAge / 3600)}h ago) — skipping Yahoo market-state check`);
  } else {
    const isClosed = await confirmMarketClosed(marketData);
    if (!isClosed) {
      log.warn("Market appears still open — aborting settlement cycle (will retry next poll)");
      return { ok: true, summary: { message: "Market still open, waiting" } };
    }
  }

  // ---- Phase 2: Double-confirm closing prices ----
  const priceResult = await doubleConfirmPrices(marketData, activeTickers);

  // Handle timed-out tickers — will attempt admin_settle after oracle-based settlement
  if (priceResult.timedOut.length > 0) {
    log.critical(`Price confirmation timed out for: ${priceResult.timedOut.join(", ")} — will attempt admin_settle fallback`);
  }

  if (priceResult.confirmed.size === 0 && priceResult.timedOut.length === 0) {
    return {
      ok: false,
      error: "No tickers had confirmed prices and none timed out",
      summary: {},
    };
  }

  // ---- Phase 3: Update oracle feeds with confirmed prices ----
  await updateOracleFeeds(oracleProgram, adminKeypair, priceResult.confirmed);

  // ---- Phase 4: Settle expired markets ----
  // Re-use markets loaded in pre-check if available, otherwise load fresh
  const allMarkets = allMarketsPreCheck;
  const settlementResult = await settleExpiredMarkets(meridianProgram, allMarkets, priceResult.confirmed);

  // ---- Phase 4b: Admin-settle timed-out tickers ----
  if (priceResult.timedOut.length > 0 && priceResult.lastKnownPrices) {
    const timedOutMarkets = allMarkets.filter((m) => {
      if (m.account.isSettled) return false;
      const ticker = tickerFromBytes(m.account.ticker);
      return priceResult.timedOut.includes(ticker);
    });
    if (timedOutMarkets.length > 0) {
      const adminResult = await adminSettleMarkets(meridianProgram, timedOutMarkets, priceResult.lastKnownPrices);
      settlementResult.settled.push(...adminResult.settled);
      settlementResult.failed.push(...adminResult.failed);
    }
  }

  // ---- Phase 5 + 5.5: Crank cancel + auto-redeem ----
  // Re-fetch markets to pick up newly settled ones (including admin-settled)
  const refreshedMarkets = await loadAllMarkets(meridianProgram);
  await crankAndRedeem(meridianProgram, refreshedMarkets, settlementResult, usdcMint);

  // ---- Phase 6: Close eligible markets ----
  await closeMarkets(meridianProgram, adminKeypair, connection);

  // ---- Phase 7: Create next-day markets ----
  await initNextDay();

  // ---- Phase 8: Unpause (autonomous retry) ----
  await unpauseWithRetry(meridianProgram, adminKeypair);

  // ---- Summary ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const summary = {
    elapsed: `${elapsed}s`,
    confirmed: [...priceResult.confirmed.entries()].map(([t, p]) => `${t}=$${p}`),
    timedOut: priceResult.timedOut,
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

  log.info(`Settlement cycle completed successfully in ${elapsed}s`, summary);
  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// Reactive polling loop
// ---------------------------------------------------------------------------

async function startPollingLoop(): Promise<never> {
  const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(RPC_URL, "confirmed");
  const ADMIN_KEYPAIR_B58 = process.env.ADMIN_KEYPAIR;

  if (!ADMIN_KEYPAIR_B58) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

  const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_KEYPAIR_B58));
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meridianProgram = new Program(meridianIdl as any, provider);

  // `settling` guards the polling loop: prevents a second settlement cycle
  // from starting while one is already running. Scoped to this loop only.
  // (M-18: there is also a separate `running` flag in the HTTP trigger server —
  //  that one guards the trigger endpoint independently. Both locks serve distinct
  //  purposes and are intentionally not shared.)
  let settling = false;

  log.info(`Settlement poller started — checking every ${POLL_INTERVAL_MS / 1000}s`);

  while (true) {
    try {
      if (!settling) {
        const allMarkets = await loadAllMarkets(meridianProgram);
        const now = Math.floor(Date.now() / 1000);
        const expired = findExpiredUnsettled(allMarkets, now);

        if (expired.length > 0) {
          const tickers = [...new Set(expired.map((m) => tickerFromBytes(m.account.ticker)))];
          log.info(`Detected ${expired.length} expired unsettled markets for tickers: ${tickers.join(", ")}`);

          settling = true;
          try {
            // Pass the pre-built connection and keypair so runSettlementCycle
            // doesn't recreate them on every cycle (avoids redundant WebSocket
            // connections and secret-key decoding).
            const result = await runSettlementCycle(connection, adminKeypair);
            if (!result.ok) {
              log.error("Settlement cycle completed with errors", result);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.critical(`Settlement cycle crashed: ${errMsg}`, {
              stack: err instanceof Error ? err.stack : undefined,
            });
          } finally {
            settling = false;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Poll cycle error: ${errMsg}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Market state override — allows admin to force market phase for testing
// ---------------------------------------------------------------------------

type MarketPhase = "auto" | "premarket" | "open" | "postmarket" | "closed";
let marketStateOverride: MarketPhase = "auto";
let overrideResetTimer: ReturnType<typeof setTimeout> | null = null;

const OVERRIDE_RESET_MS = 30 * 60 * 1000; // 30 minutes

/** Returns the overridden market state, or "auto" to use real clock. */
export function getMarketStateOverride(): MarketPhase {
  return marketStateOverride;
}

function setMarketStateWithTimer(phase: MarketPhase): void {
  // Clear any existing reset timer
  if (overrideResetTimer) {
    clearTimeout(overrideResetTimer);
    overrideResetTimer = null;
  }

  marketStateOverride = phase;

  // Auto-reset to "auto" after 30 minutes (unless already "auto")
  if (phase !== "auto") {
    overrideResetTimer = setTimeout(() => {
      log.info("Market state override expired after 30 minutes — resetting to auto");
      marketStateOverride = "auto";
      overrideResetTimer = null;
    }, OVERRIDE_RESET_MS);
  }
}

// ---------------------------------------------------------------------------
// HTTP trigger + admin server
// ---------------------------------------------------------------------------

function startTriggerServer(): void {
  const port = parseInt(process.env.TRIGGER_PORT ?? "4002", 10);
  // `running` guards the HTTP trigger endpoint: prevents concurrent settlement
  // cycles triggered via POST /trigger. Intentionally separate from the polling
  // loop's `settling` flag — the two code paths are independent and may both be
  // active at once (e.g. a manual trigger during an autonomous poll cycle).
  // (M-18: see also `settling` in startPollingLoop for the other lock.)
  let running = false;

  const triggerToken = process.env.SETTLEMENT_TRIGGER_TOKEN ?? null;

  const VALID_PHASES: MarketPhase[] = ["auto", "premarket", "open", "postmarket", "closed"];

  const server = http.createServer(async (req, res) => {
    // CORS headers for admin page access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint for Railway and inter-service checks
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "settlement" }));
      return;
    }

    // Market state override endpoint — GET returns current, POST sets it
    if (req.url === "/market-state") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: marketStateOverride }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const { state } = JSON.parse(body);
            if (!VALID_PHASES.includes(state)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Invalid state. Valid: ${VALID_PHASES.join(", ")}` }));
              return;
            }
            setMarketStateWithTimer(state);
            log.info(`Market state override set to: ${state} (resets to auto in 30m)`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, state: marketStateOverride }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body. Expected: {\"state\": \"...\"}" }));
          }
        });
        return;
      }
    }

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

  const host = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host, () => {
    log.info(`Settlement trigger server listening on ${host}:${port} (POST /trigger)`);
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = process.env.MARKET_DATA_SOURCE ?? "live";
  log.info(`=== Settlement Service starting (${mode} mode — poller + trigger server) ===`);

  // Always start the HTTP trigger server for manual/scheduler-triggered settlement
  startTriggerServer();

  // Always start the polling loop — on-chain marketCloseUnix is authoritative
  // regardless of data source. The poller detects expired unsettled markets and
  // settles them autonomously.
  await startPollingLoop();
}

main().catch((err) => {
  log.critical("Fatal error in settlement service", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
