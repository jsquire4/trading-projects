// ---------------------------------------------------------------------------
// Oracle Feeder — Synthetic mode
//
// Simple polling feeder that evolves prices via SyntheticClient (GBM)
// every 5 seconds. No external API dependency.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { findPriceFeed } from "../../shared/src/pda.js";
import { updateOnChain } from "./oracle-helpers.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" with { type: "json" };

const log = createLogger("oracle-feeder:synthetic");

const POLL_INTERVAL_MS = 5_000; // 5 seconds

export interface FeederHandle {
  stop(): void;
}

export async function startSyntheticFeeder(
  tickers: string[],
  connection: Connection,
  authority: Keypair,
): Promise<FeederHandle> {
  if (tickers.length === 0) {
    throw new Error("No tickers provided to synthetic feeder");
  }

  // Build Anchor program handle for mock_oracle
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

  // Create synthetic market data client
  const client: IMarketDataClient = createMarketDataClient();

  let stopped = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  async function pollAndUpdate(): Promise<void> {
    try {
      const quotes = await client.getQuotes(tickers);
      for (const q of quotes) {
        if (q.last > 0) {
          const priceFeed = priceFeedPDAs.get(q.symbol);
          if (priceFeed) {
            await updateOnChain(program, authority, priceFeed, q.symbol, q.last);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Synthetic quote fetch failed", { error: msg });
    }
  }

  // Seed prices immediately
  log.info("Seeding initial synthetic prices...");
  await pollAndUpdate();

  // Poll every 5 seconds
  pollInterval = setInterval(() => {
    if (!stopped) {
      pollAndUpdate().catch((err) => {
        log.warn("Synthetic poll error", { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }, POLL_INTERVAL_MS);

  log.info(`Synthetic feeder running — polling every ${POLL_INTERVAL_MS / 1000}s`);

  return {
    stop() {
      stopped = true;
      if (pollInterval) clearInterval(pollInterval);
      log.info("Synthetic feeder stopped");
    },
  };
}
