// ---------------------------------------------------------------------------
// Oracle Feeder — Entry point
//
// Reads active tickers from on-chain GlobalConfig (or TICKERS env override),
// then streams real-time prices from Tradier and updates mock_oracle feeds.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig } from "../../shared/src/pda.js";
import { startFeeder, type FeederHandle } from "./feeder.js";

import type { Meridian } from "../../shared/src/idl/meridian.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };

const log = createLogger("oracle-feeder");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Read active tickers from on-chain GlobalConfig via Anchor IDL. */
async function readTickersFromChain(
  connection: Connection,
): Promise<string[]> {
  const [configPda] = findGlobalConfig();
  log.info(`Reading GlobalConfig at ${configPda.toBase58()}`);

  // Build a read-only Anchor program (no signer needed for fetch)
  const dummyKeypair = Keypair.generate();
  const wallet = new Wallet(dummyKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program<Meridian>(
    MeridianIDL as unknown as Meridian,
    provider,
  );

  const globalConfig = await (program.account as any).globalConfig.fetch(
    configPda,
  );

  const tickerCount = (globalConfig.tickerCount as number) ?? 0;
  if (tickerCount === 0 || tickerCount > 7) {
    throw new Error(`Unexpected ticker_count: ${tickerCount}`);
  }

  const tickerArrays = globalConfig.tickers as number[][];
  const tickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const t = Buffer.from(tickerArrays[i])
      .toString("utf-8")
      .replace(/\0+$/, "");
    if (t.length > 0) {
      tickers.push(t);
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
