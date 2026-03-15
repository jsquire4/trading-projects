/**
 * SQLite Database Layer
 *
 * Connection pool, initialization, migrations, and re-exports.
 * Event CRUD lives in queries.ts; cost basis / portfolio in mapper.ts.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { createLogger } from "../../shared/src/alerting.ts";

const log = createLogger("event-indexer:db");

export interface EventRow {
  id?: number;
  type: string;
  market: string;
  data: string;
  signature: string;
  slot: number;
  timestamp: number;
  seq: number;
  created_at?: string;
}

export interface Checkpoint {
  last_signature: string;
  last_slot: number;
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.DB_PATH ?? "./data/events.db";
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      market TEXT NOT NULL,
      data TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_market ON events(market);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_signature TEXT NOT NULL,
      last_slot INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_intents (
      order_id TEXT NOT NULL,
      market TEXT NOT NULL,
      wallet TEXT NOT NULL,
      intent TEXT NOT NULL,
      display_price INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (order_id, market, wallet)
    );
    CREATE INDEX IF NOT EXISTS idx_order_intents_wallet ON order_intents(wallet);
  `);

  // Migration: add seq column to existing databases and fix unique index
  try {
    db.exec(`ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — expected on fresh databases or after first migration
  }
  db.exec(`DROP INDEX IF EXISTS idx_events_sig_type`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig_type_seq ON events(signature, type, market, seq)`);

  // Reset cached prepared statements in queries.ts (they reference old db handle)
  resetInsertStmt();

  log.info("Database initialized", { path: resolvedPath });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    resetInsertStmt();
    log.info("Database closed");
  }
}

// --------------- Re-exports from queries.ts ---------------
import {
  insertEvent,
  insertEventsBatch,
  queryEvents,
  getLatestEvents,
  getEventCount,
  signatureExists,
  getCheckpoint,
  upsertCheckpoint,
  insertOrderIntent,
  resetInsertStmt,
  type OrderIntent,
} from "./queries.js";

export {
  insertEvent,
  insertEventsBatch,
  queryEvents,
  getLatestEvents,
  getEventCount,
  signatureExists,
  getCheckpoint,
  upsertCheckpoint,
  insertOrderIntent,
  type OrderIntent,
};

// --------------- Re-exports from mapper.ts ---------------
import {
  queryCostBasis,
  queryMarketVwaps,
  queryFillsWithIntent,
  queryPortfolioSnapshot,
  queryPortfolioHistory,
  type CostBasisRow,
  type MarketVwap,
  type FillWithIntent,
  type PortfolioPosition,
  type DailySummary,
} from "./mapper.js";

export {
  queryCostBasis,
  queryMarketVwaps,
  queryFillsWithIntent,
  queryPortfolioSnapshot,
  queryPortfolioHistory,
  type CostBasisRow,
  type MarketVwap,
  type FillWithIntent,
  type PortfolioPosition,
  type DailySummary,
};
