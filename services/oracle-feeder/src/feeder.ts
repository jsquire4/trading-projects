// ---------------------------------------------------------------------------
// Oracle Feeder — Core logic
//
// Streams real-time stock prices from Tradier and pushes them on-chain
// to the mock_oracle PriceFeed accounts.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import { TradierClient } from "../../shared/src/tradier-client.js";
import { createLogger } from "../../shared/src/alerting.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" assert { type: "json" };

const log = createLogger("oracle-feeder");

const MOCK_ORACLE_PROGRAM_ID = new PublicKey(
  "HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ",
);

const TRADIER_WS_URL = "wss://ws.tradier.com/v1/markets/events";

// Rate limit: max 1 update per ticker per 5 seconds
const RATE_LIMIT_MS = 5_000;

// Retry config
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padTicker(ticker: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  const bytes = Buffer.from(ticker, "utf-8");
  if (bytes.length > 8) {
    throw new Error(`Ticker "${ticker}" exceeds 8 bytes when UTF-8 encoded`);
  }
  bytes.copy(buf);
  return buf;
}

function findPriceFeedPDA(ticker: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), padTicker(ticker)],
    MOCK_ORACLE_PROGRAM_ID,
  );
}

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
  /** Gracefully shut down the streaming connection. */
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
    const [pda] = findPriceFeedPDA(ticker);
    priceFeedPDAs.set(ticker, pda);
    log.info(`PriceFeed PDA for ${ticker}: ${pda.toBase58()}`);
  }

  // Rate-limit tracking: last update timestamp per ticker
  const lastUpdate = new Map<string, number>();

  // Tradier client for session creation
  const tradierClient = new TradierClient();

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // ------ On-chain update with retry ------

  async function updateOnChain(ticker: string, price: number): Promise<void> {
    const priceFeed = priceFeedPDAs.get(ticker);
    if (!priceFeed) return;

    // Rate limit check
    const now = Date.now();
    const last = lastUpdate.get(ticker) ?? 0;
    if (now - last < RATE_LIMIT_MS) return;
    lastUpdate.set(ticker, now);

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

  // ------ WebSocket streaming ------

  async function connect(): Promise<void> {
    if (stopped) return;

    let sessionId: string;
    try {
      sessionId = await tradierClient.createStreamSession();
      log.info("Created Tradier streaming session");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to create stream session, retrying in 10s", {
        error: msg,
      });
      reconnectTimeout = setTimeout(() => connect(), 10_000);
      return;
    }

    ws = new WebSocket(TRADIER_WS_URL);

    ws.on("open", () => {
      log.info(`WebSocket connected, subscribing to: ${tickers.join(", ")}`);
      ws!.send(
        JSON.stringify({
          symbols: tickers,
          sessionid: sessionId,
          filter: ["trade"],
        }),
      );
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        // Tradier sends newline-delimited JSON
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const msg = JSON.parse(trimmed);

          // Trade events have type "trade"
          if (msg.type === "trade" && msg.symbol && typeof msg.price === "number") {
            updateOnChain(msg.symbol, msg.price);
          }
        }
      } catch {
        // Ignore parse errors on heartbeats or malformed messages
      }
    });

    ws.on("close", (code: number) => {
      if (stopped) return;
      log.warn(`WebSocket closed (code ${code}), reconnecting in 5s`);
      reconnectTimeout = setTimeout(() => connect(), 5_000);
    });

    ws.on("error", (err: Error) => {
      log.error("WebSocket error", { error: err.message });
      // close handler will trigger reconnect
    });
  }

  // Start the connection
  await connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
      }
      log.info("Feeder stopped");
    },
  };
}
