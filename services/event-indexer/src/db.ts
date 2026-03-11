/**
 * SQLite Database Layer
 *
 * Persists parsed Anchor events and maintains a checkpoint for
 * incremental backfill resumption.
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
  `);

  // Migration: add seq column to existing databases and fix unique index
  try {
    db.exec(`ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — expected on fresh databases or after first migration
  }
  db.exec(`DROP INDEX IF EXISTS idx_events_sig_type`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig_type_seq ON events(signature, type, market, seq)`);

  log.info("Database initialized", { path: resolvedPath });
  return db;
}

// --------------- Event operations ---------------

let _insertEvent: Database.Statement | null = null;

function getInsertStmt(): Database.Statement {
  if (!_insertEvent) {
    _insertEvent = getDb().prepare(`
      INSERT OR IGNORE INTO events (type, market, data, signature, slot, timestamp, seq)
      VALUES (@type, @market, @data, @signature, @slot, @timestamp, @seq)
    `);
  }
  return _insertEvent;
}

export function insertEvent(row: Omit<EventRow, "id" | "created_at">): void {
  getInsertStmt().run({ ...row, seq: row.seq ?? 0 });
}

export function insertEventsBatch(
  rows: Omit<EventRow, "id" | "created_at">[],
): void {
  if (rows.length === 0) return;
  const stmt = getInsertStmt();
  const tx = getDb().transaction((items: typeof rows) => {
    for (const row of items) {
      stmt.run({ ...row, seq: row.seq ?? 0 });
    }
  });
  tx(rows);
}

export function queryEvents(opts: {
  market?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): EventRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.market) {
    clauses.push("market = @market");
    params.market = opts.market;
  }
  if (opts.type) {
    clauses.push("type = @type");
    params.type = opts.type;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;

  const stmt = getDb().prepare(
    `SELECT * FROM events ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit OFFSET @offset`,
  );
  return stmt.all({ ...params, limit, offset }) as EventRow[];
}

export function getLatestEvents(count: number = 20): EventRow[] {
  return getDb()
    .prepare("SELECT * FROM events ORDER BY timestamp DESC, id DESC LIMIT ?")
    .all(count) as EventRow[];
}

export function getEventCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as cnt FROM events")
    .get() as { cnt: number };
  return row.cnt;
}

// --------------- Checkpoint operations ---------------

export function getCheckpoint(): Checkpoint | null {
  const row = getDb()
    .prepare("SELECT last_signature, last_slot FROM checkpoints WHERE id = 1")
    .get() as Checkpoint | undefined;
  return row ?? null;
}

export function upsertCheckpoint(sig: string, slot: number): void {
  getDb()
    .prepare(
      `INSERT INTO checkpoints (id, last_signature, last_slot, updated_at)
       VALUES (1, @sig, @slot, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         last_signature = @sig,
         last_slot = @slot,
         updated_at = datetime('now')`,
    )
    .run({ sig, slot });
}

// --------------- Cost basis aggregation ---------------

export interface CostBasisRow {
  market: string;
  side: 'yes' | 'no';
  avgPrice: number;       // weighted average fill price in cents
  totalQuantity: number;  // total tokens acquired (micro-tokens)
  totalCostUsdc: number;  // total USDC spent (in micro-USDC × cents)
  fillCount: number;
}

export function queryCostBasis(wallet: string): CostBasisRow[] {
  // Fill events have JSON data with: maker, taker, price, quantity, takerSide, makerSide
  // Buy-side fills:
  //   - Taker buys Yes: taker = wallet AND takerSide = 0 (USDC_BID)
  //   - Taker buys No:  taker = wallet AND takerSide = 2 (NO_BID)
  //   - Maker bought when taker sold: maker = wallet AND takerSide = 1 (YES_ASK)
  // Discriminate by side: takerSide 0 → 'yes', takerSide 2 → 'no', takerSide 1 (maker fill) → 'yes'
  const stmt = getDb().prepare(`
    SELECT
      market,
      CASE
        WHEN json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 0 THEN 'yes'
        WHEN json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 2 THEN 'no'
        WHEN json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1 THEN 'yes'
      END as side,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalQuantity,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL) * CAST(json_extract(data, '$.price') AS REAL)) as totalCost,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
      AND (
        (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) IN (0, 2))
        OR
        (json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1)
      )
    GROUP BY market, side
    HAVING side IS NOT NULL
  `);

  const rows = stmt.all({ wallet }) as { market: string; side: 'yes' | 'no'; totalQuantity: number; totalCost: number; fillCount: number }[];

  return rows.map(r => ({
    market: r.market,
    side: r.side,
    totalQuantity: r.totalQuantity,
    totalCostUsdc: r.totalCost,
    avgPrice: r.totalQuantity > 0 ? r.totalCost / r.totalQuantity : 0,
    fillCount: r.fillCount,
  }));
}

// --------------- Market VWAP aggregation ---------------

export interface MarketVwap {
  market: string;
  vwap: number;         // volume-weighted average fill price in cents
  totalVolume: number;  // total quantity filled (micro-tokens)
  fillCount: number;
}

export function queryMarketVwaps(): MarketVwap[] {
  // VWAP = sum(price * quantity) / sum(quantity) for all fills per market
  const stmt = getDb().prepare(`
    SELECT
      market,
      SUM(CAST(json_extract(data, '$.price') AS REAL) * CAST(json_extract(data, '$.quantity') AS REAL)) /
        NULLIF(SUM(CAST(json_extract(data, '$.quantity') AS REAL)), 0) as vwap,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalVolume,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
    GROUP BY market
  `);
  return stmt.all() as MarketVwap[];
}

export function signatureExists(signature: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM events WHERE signature = ? LIMIT 1")
    .get(signature);
  return row !== undefined;
}

export function closeDb(): void {
  if (db) {
    db.close();
    _insertEvent = null;
    log.info("Database closed");
  }
}
