// ---------------------------------------------------------------------------
// Oracle Feeder — Core logic
//
// Polls real-time stock prices via the market data client (Yahoo Finance or
// synthetic) and pushes them on-chain to mock_oracle PriceFeed accounts.
//
// Also monitors Yahoo marketState:
// - Only updates prices when market is REGULAR
// - Trips circuit breaker if market closes unexpectedly before market_close_unix
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { findPriceFeed, findGlobalConfig } from "../../shared/src/pda.js";
import { tickerFromBytes } from "../../shared/src/utils.js";
import { updateOnChain } from "./oracle-helpers.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" with { type: "json" };

import type { Meridian } from "../../shared/src/idl/meridian.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };

const log = createLogger("oracle-feeder");

// Rate limit: max 1 update per ticker per 5 seconds
const RATE_LIMIT_MS = 5_000;

// Poll interval (configurable via env)
const POLL_INTERVAL_MS = parseInt(process.env.ORACLE_POLL_INTERVAL_MS ?? "10000", 10);

// Market state check interval — every 30s (separate from price poll)
const MARKET_STATE_CHECK_INTERVAL_MS = 30_000;

// Retry config
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Core feeder
// ---------------------------------------------------------------------------

export interface FeederHandle {
  /** Gracefully shut down the polling loop. */
  stop(): void;
}

export async function startFeeder(
  tickers: string[],
  connection: Connection,
  authority: Keypair,
): Promise<FeederHandle> {
  if (tickers.length === 0) {
    throw new Error("No tickers provided to feeder");
  }

  // Build Anchor program handles
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const oracleProgram = new Program<MockOracle>(
    MockOracleIDL as unknown as MockOracle,
    provider,
  );
  // Meridian program needed for pause instruction
  const meridianProgram = new Program<Meridian>(
    MeridianIDL as unknown as Meridian,
    provider,
  );

  // Pre-derive all PDA addresses
  const priceFeedPDAs = new Map<string, PublicKey>();
  for (const ticker of tickers) {
    const [pda] = findPriceFeed(ticker);
    priceFeedPDAs.set(ticker, pda);
    log.info(`PriceFeed PDA for ${ticker}: ${pda.toBase58()}`);
  }

  // Rate-limit tracking: last update timestamp per ticker
  const lastUpdate = new Map<string, number>();

  // Market data client (Yahoo Finance or synthetic)
  const client: IMarketDataClient = createMarketDataClient();

  // Market state tracking
  let lastKnownState = "unknown";
  // Check on-chain pause state at startup so we don't resume feeding
  // prices on a paused platform after a feeder restart (SH-1).
  let circuitBreakerTripped = false;
  try {
    const [configPda] = findGlobalConfig();
    const configAcct = await (meridianProgram.account as any).globalConfig.fetch(configPda);
    if (configAcct.isPaused) {
      circuitBreakerTripped = true;
      log.info("Platform is paused on-chain — feeder starting in paused mode");
    }
  } catch {
    // Config not found — devnet may not be initialized. Proceed normally.
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let stateCheckInterval: ReturnType<typeof setInterval> | null = null;

  // ------ On-chain update with rate limiting + retry ------

  async function updateTickerOnChain(ticker: string, price: number): Promise<void> {
    const priceFeed = priceFeedPDAs.get(ticker);
    if (!priceFeed) return;

    // Rate limit check
    const now = Date.now();
    const last = lastUpdate.get(ticker) ?? 0;
    if (now - last < RATE_LIMIT_MS) return;

    const ok = await updateOnChain(oracleProgram, authority, priceFeed, ticker, price, {
      maxRetries: MAX_RETRIES,
      baseRetryDelayMs: BASE_RETRY_DELAY_MS,
    });
    if (ok) {
      lastUpdate.set(ticker, Date.now());
    }
  }

  // ------ Get earliest active market close time ------

  async function getEarliestMarketClose(): Promise<number | null> {
    try {
      const allMarkets = await (meridianProgram.account as any).strikeMarket.all();
      const now = Math.floor(Date.now() / 1000);
      let earliest: number | null = null;

      for (const m of allMarkets) {
        if (m.account.isSettled) continue;
        const closeUnix = (m.account.marketCloseUnix as BN).toNumber();
        if (closeUnix > now) {
          if (earliest === null || closeUnix < earliest) {
            earliest = closeUnix;
          }
        }
      }

      return earliest;
    } catch {
      return null;
    }
  }

  // ------ Trip circuit breaker ------

  async function tripCircuitBreaker(reason: string): Promise<void> {
    if (circuitBreakerTripped) return;

    log.critical(`Tripping circuit breaker: ${reason}`);
    // Don't set flag yet — wait for RPC confirmation

    const [configPda] = findGlobalConfig();

    try {
      await (meridianProgram.methods as any)
        .pause()
        .accounts({
          admin: authority.publicKey,
          config: configPda,
        })
        .rpc();

      circuitBreakerTripped = true;
      log.critical("Circuit breaker activated — platform paused", { reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // AlreadyPaused (6023) is fine — someone else paused it
      if (msg.includes("AlreadyPaused") || msg.includes("6023")) {
        circuitBreakerTripped = true;
        log.info("Platform already paused — circuit breaker is a no-op");
      } else {
        // Flag NOT set — will retry on next state check interval
        log.critical(`Failed to trip circuit breaker: ${msg}`, { reason });
      }
    }
  }

  // ------ Market state monitor ------

  async function checkMarketState(): Promise<void> {
    try {
      const clock = await client.getMarketClock();
      const state = clock.state.toLowerCase();

      // Detect transition from REGULAR to CLOSED/POST
      if (lastKnownState === "open" && (state === "closed" || state === "postmarket")) {
        // Is this expected? Check if it's after the earliest market close time
        const earliestClose = await getEarliestMarketClose();
        const now = Math.floor(Date.now() / 1000);

        if (earliestClose !== null && now < earliestClose) {
          // Unexpected close — market closed before our market_close_unix
          await tripCircuitBreaker(
            `Yahoo reports market ${state} but earliest market_close_unix is ${earliestClose} (${Math.round((earliestClose - now) / 60)} min from now)`,
          );
        } else {
          // Expected close — settlement service will handle it
          log.info(`Market transitioned to ${state} (expected — at or past market close)`);
        }
      }

      lastKnownState = state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Market state check failed: ${msg}`);
      // Don't change lastKnownState on failure — preserve last known good state
    }
  }

  // ------ REST-based price fetch ------

  async function fetchAndUpdateViaREST(): Promise<void> {
    if (circuitBreakerTripped) return;

    try {
      const quotes = await client.getQuotes(tickers);
      for (const q of quotes) {
        if (q.last > 0) {
          await updateTickerOnChain(q.symbol, q.last);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("REST quote fetch failed", { error: msg });
    }
  }

  // ------ Start ------

  // Check market state first
  await checkMarketState();
  log.info(`Market state on startup: ${lastKnownState}`);

  // Always seed prices on startup — even when market is closed, the oracle
  // needs a non-zero price and a fresh timestamp for the frontend to display.
  log.info("Seeding initial prices via REST API...");
  await fetchAndUpdateViaREST();

  // Poll prices: fast (10s) when market is open, slow (5 min) when closed.
  // Closed-market updates keep the oracle timestamp fresh for display.
  const CLOSED_POLL_INTERVAL_MS = 5 * 60 * 1000;
  let lastClosedUpdate = 0;
  log.info(`Starting REST poll loop (open: ${POLL_INTERVAL_MS}ms, closed: ${CLOSED_POLL_INTERVAL_MS}ms)`);
  pollInterval = setInterval(() => {
    if (lastKnownState === "open" || lastKnownState === "unknown") {
      fetchAndUpdateViaREST().catch(() => {});
    } else {
      // Closed market: only update every 5 minutes
      const now = Date.now();
      if (now - lastClosedUpdate >= CLOSED_POLL_INTERVAL_MS) {
        lastClosedUpdate = now;
        fetchAndUpdateViaREST().catch(() => {});
      }
    }
  }, POLL_INTERVAL_MS);

  // Market state check at separate interval
  log.info(`Starting market state monitor (interval: ${MARKET_STATE_CHECK_INTERVAL_MS}ms)`);
  stateCheckInterval = setInterval(() => {
    checkMarketState().catch(() => {});
  }, MARKET_STATE_CHECK_INTERVAL_MS);

  return {
    stop() {
      if (pollInterval) clearInterval(pollInterval);
      if (stateCheckInterval) clearInterval(stateCheckInterval);
      log.info("Feeder stopped");
    },
  };
}
