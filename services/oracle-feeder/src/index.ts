// ---------------------------------------------------------------------------
// Oracle Feeder — Entry point
//
// Reads active tickers from on-chain GlobalConfig (or TICKERS env override),
// then streams real-time prices from Tradier and updates mock_oracle feeds.
// ---------------------------------------------------------------------------

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "../../shared/src/alerting.js";
import { startFeeder, type FeederHandle } from "./feeder.js";

const log = createLogger("oracle-feeder");

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

const MERIDIAN_PROGRAM_ID = new PublicKey(
  "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth",
);

// ---------------------------------------------------------------------------
// Config constants for reading GlobalConfig on-chain
// ---------------------------------------------------------------------------

// GlobalConfig account discriminator (first 8 bytes)
const GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from([
  149, 8, 156, 202, 160, 252, 176, 217,
]);

// On-chain layout offsets (after 8-byte discriminator):
//   admin:                Pubkey  (32)  offset  8
//   usdc_mint:            Pubkey  (32)  offset 40
//   oracle_program:       Pubkey  (32)  offset 72
//   staleness_threshold:  u64    (8)   offset 104
//   settlement_staleness: u64    (8)   offset 112
//   confidence_bps:       u64    (8)   offset 120
//   is_paused:            bool   (1)   offset 128
//   oracle_type:          u8     (1)   offset 129
//   tickers:              [u8;8]*7 (56) offset 130
//   ticker_count:         u8     (1)   offset 186

const TICKERS_OFFSET = 130; // 8 disc + 32+32+32+8+8+8+1+1
const TICKER_COUNT_OFFSET = 186; // 8 disc + 32+32+32+8+8+8+1+1+56
const TICKER_SIZE = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findGlobalConfig(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID,
  );
}

function loadKeypair(): Keypair {
  const encoded = process.env.FEEDER_KEYPAIR;
  if (!encoded) {
    throw new Error(
      "FEEDER_KEYPAIR env var is required (base58-encoded secret key)",
    );
  }
  const secretKey = bs58.decode(encoded);
  return Keypair.fromSecretKey(secretKey);
}

/** Read active tickers from on-chain GlobalConfig. */
async function readTickersFromChain(
  connection: Connection,
): Promise<string[]> {
  const [configPda] = findGlobalConfig();
  log.info(`Reading GlobalConfig at ${configPda.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(configPda);
  if (!accountInfo) {
    throw new Error(
      `GlobalConfig account not found at ${configPda.toBase58()}. Has the program been initialized?`,
    );
  }

  const data = Buffer.from(accountInfo.data);

  // Verify discriminator
  const disc = data.subarray(0, 8);
  if (!disc.equals(GLOBAL_CONFIG_DISCRIMINATOR)) {
    throw new Error("GlobalConfig discriminator mismatch — wrong account?");
  }

  const tickerCount = data.readUInt8(TICKER_COUNT_OFFSET);
  if (tickerCount === 0 || tickerCount > 7) {
    throw new Error(`Unexpected ticker_count: ${tickerCount}`);
  }

  const tickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const start = TICKERS_OFFSET + i * TICKER_SIZE;
    const raw = data.subarray(start, start + TICKER_SIZE);
    // Strip zero-padding
    const end = raw.indexOf(0);
    const ticker = raw.subarray(0, end === -1 ? TICKER_SIZE : end).toString("utf-8");
    if (ticker.length > 0) {
      tickers.push(ticker);
    }
  }

  return tickers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("Oracle Feeder starting up");

  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  log.info(`RPC: ${rpcUrl}`);

  const authority = loadKeypair();
  log.info(`Authority: ${authority.publicKey.toBase58()}`);

  // Determine tickers: env override or on-chain
  let tickers: string[];
  const tickerOverride = process.env.TICKERS;
  if (tickerOverride) {
    tickers = tickerOverride
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    log.info(`Using TICKERS env override: ${tickers.join(", ")}`);
  } else {
    tickers = await readTickersFromChain(connection);
    log.info(`Loaded tickers from GlobalConfig: ${tickers.join(", ")}`);
  }

  if (tickers.length === 0) {
    log.error("No tickers to feed — exiting");
    process.exit(1);
  }

  const feeder = await startFeeder(tickers, connection, authority);

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down gracefully`);
    feeder.stop();
    // Give a moment for final logs to flush
    setTimeout(() => process.exit(0), 500);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("Oracle Feeder running — press Ctrl+C to stop");
}

main().catch((err) => {
  log.critical("Fatal error in oracle-feeder", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
