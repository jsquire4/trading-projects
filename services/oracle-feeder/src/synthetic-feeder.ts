// ---------------------------------------------------------------------------
// Oracle Feeder — Synthetic mode
//
// Simple polling feeder that evolves prices via SyntheticClient (GBM)
// every 5 seconds. No external API dependency.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { findPriceFeed } from "../../shared/src/pda.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" with { type: "json" };

const log = createLogger("oracle-feeder:synthetic");

const POLL_INTERVAL_MS = 5_000; // 5 seconds

/** Convert a dollar price (e.g. 185.42) to USDC lamports (u64). */
function priceToLamports(price: number): BN {
  return new BN(Math.round(price * 1_000_000));
}

/** Confidence = 0.1% of price (conservative). */
function computeConfidence(price: number): BN {
  return new BN(Math.round(price * 1_000_000 * 0.001));
}

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

  async function updateOnChain(ticker: string, price: number): Promise<void> {
    const priceFeed = priceFeedPDAs.get(ticker);
    if (!priceFeed) return;

    const priceLamports = priceToLamports(price);
    const confidence = computeConfidence(price);
    const timestamp = new BN(Math.floor(Date.now() / 1000));

    try {
      await program.methods
        .updatePrice(priceLamports, confidence, timestamp)
        .accounts({
          authority: authority.publicKey,
          priceFeed,
        })
        .signers([authority])
        .rpc();

      log.info(`Updated ${ticker}: $${price.toFixed(2)}`, {
        lamports: priceLamports.toString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to update ${ticker} on-chain`, { error: msg });
    }
  }

  async function pollAndUpdate(): Promise<void> {
    try {
      const quotes = await client.getQuotes(tickers);
      for (const q of quotes) {
        if (q.last > 0) {
          await updateOnChain(q.symbol, q.last);
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
