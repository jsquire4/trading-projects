/**
 * Event Indexer — Entry Point
 *
 * Watches for Anchor program events (FillEvent, SettlementEvent,
 * CrankCancelEvent) and persists them to SQLite. Provides a REST API
 * for the frontend History page.
 *
 * Startup sequence:
 *   1. Initialize SQLite database
 *   2. Run backfill from last checkpoint
 *   3. Start live event listener via connection.onLogs
 *   4. Start REST API server
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createLogger } from "../../shared/src/alerting.ts";
import { initDb, closeDb } from "./db.js";
import { runBackfill } from "./backfill.js";
import { startLiveListener, stopLiveListener } from "./listener.js";
import { startApiServer } from "./api.js";

import idlJson from "../../shared/src/idl/meridian.json" with { type: "json" };
import type { Idl } from "@coral-xyz/anchor";

const log = createLogger("event-indexer");

const PROGRAM_ID = "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_PORT = 3001;

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const dbPath = process.env.DB_PATH ?? "./data/events.db";
  const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const programId = new PublicKey(PROGRAM_ID);
  const idl = idlJson as unknown as Idl;

  log.info("Event Indexer starting", { rpcUrl, dbPath, port, programId: PROGRAM_ID });

  // 1. Initialize database
  initDb(dbPath);

  // 2. Connect to Solana
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: rpcUrl.replace("https://", "wss://").replace("http://", "ws://"),
  });

  // 3. Run backfill from last checkpoint
  try {
    await runBackfill(connection, programId, idl);
  } catch (err) {
    log.error("Backfill failed — continuing with live listener", {
      error: String(err),
    });
  }

  // 4. Start live event listener
  startLiveListener(connection, programId, idl);

  // 5. Start REST API
  const server = startApiServer(port);

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    server.close();
    await stopLiveListener(connection);
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("Event Indexer running");
}

main().catch((err) => {
  log.critical("Fatal startup error", { error: String(err) });
  process.exit(1);
});
