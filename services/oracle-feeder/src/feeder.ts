// ---------------------------------------------------------------------------
// Oracle Feeder — Core logic
//
// Polls real-time stock prices via the market data client (Yahoo Finance or
// synthetic) and pushes them on-chain to mock_oracle PriceFeed accounts.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { findPriceFeed } from "../../shared/src/pda.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" with { type: "json" };

const log = createLogger("oracle-feeder");

// Rate limit: max 1 update per ticker per 5 seconds
const RATE_LIMIT_MS = 5_000;

// Poll interval (configurable via env)
const POLL_INTERVAL_MS = parseInt(process.env.ORACLE_POLL_INTERVAL_MS ?? "10000", 10);

// Retry config
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

/** Convert a dollar price (e.g. 185.42) to USDC lamports (u64). */
function priceToLamports(price: number): BN {
  return new BN(Math.round(price * 1_000_000));
}

/** Confidence = 0.1% of price (conservative). */
function computeConfidence(price: number): BN {
  return new BN(Math.round(price * 1_000_000 * 0.001));
}

async function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // Build Anchor program handle
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program<MockOracle>(
    MockOracleIDL as unknown as MockOracle,
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

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // ------ On-chain update with retry ------

  async function updateOnChain(ticker: string, price: number): Promise<void> {
    const priceFeed = priceFeedPDAs.get(ticker);
    if (!priceFeed) return;

    // Rate limit check
    const now = Date.now();
    const last = lastUpdate.get(ticker) ?? 0;
    if (now - last < RATE_LIMIT_MS) return;

    const priceLamports = priceToLamports(price);
    const confidence = computeConfidence(price);
    const timestamp = new BN(Math.floor(now / 1000));

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await program.methods
          .updatePrice(priceLamports, confidence, timestamp)
          .accounts({
            authority: authority.publicKey,
            priceFeed,
          })
          .signers([authority])
          .rpc();

        lastUpdate.set(ticker, Date.now());
        log.info(`Updated ${ticker}: $${price.toFixed(2)}`, {
          lamports: priceLamports.toString(),
          confidence: confidence.toString(),
        });
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          log.warn(
            `Tx failed for ${ticker} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms`,
            { error: msg },
          );
          await sleepMs(delay);
        } else {
          log.error(
            `Tx failed for ${ticker} after ${MAX_RETRIES} attempts, dropping update`,
            { error: msg, price },
          );
        }
      }
    }
  }

  // ------ REST-based price fetch ------

  async function fetchAndUpdateViaREST(): Promise<void> {
    try {
      const quotes = await client.getQuotes(tickers);
      for (const q of quotes) {
        if (q.last > 0) {
          await updateOnChain(q.symbol, q.last);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("REST quote fetch failed", { error: msg });
    }
  }

  // Seed prices immediately via REST so feeds aren't stale on startup
  log.info("Seeding initial prices via REST API...");
  await fetchAndUpdateViaREST();

  // Poll at configured interval
  log.info(`Starting REST poll loop (interval: ${POLL_INTERVAL_MS}ms)`);
  pollInterval = setInterval(() => {
    fetchAndUpdateViaREST().catch(() => {});
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      if (pollInterval) clearInterval(pollInterval);
      log.info("Feeder stopped");
    },
  };
}
