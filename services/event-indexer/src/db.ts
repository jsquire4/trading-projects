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
  // Acquisition fills (cost basis = tokens obtained):
  //   - Taker buys Yes: taker = wallet AND takerSide = 0 (USDC_BID)
  //   - Maker bought Yes when taker sold: maker = wallet AND takerSide = 1 (YES_ASK) → maker is USDC bid side
  // takerSide=2 (NO_BID) is EXCLUDED — taker sends No tokens FROM wallet to escrow (selling, not acquiring)
  const stmt = getDb().prepare(`
    SELECT
      market,
      CASE
        WHEN json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 0 THEN 'yes'
        WHEN json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1 THEN 'yes'
      END as side,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalQuantity,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL) * CAST(json_extract(data, '$.price') AS REAL)) as totalCost,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
      AND (
        (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 0)
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

// --------------- Order intent operations ---------------

export interface OrderIntent {
  order_id: string;
  market: string;
  wallet: string;
  intent: string;       // "buy_yes" | "sell_yes" | "buy_no" | "sell_no"
  display_price: number; // price in cents from user's perspective
}

export function insertOrderIntent(intent: OrderIntent): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO order_intents (order_id, market, wallet, intent, display_price)
       VALUES (@order_id, @market, @wallet, @intent, @display_price)`,
    )
    .run(intent);
}

export interface FillWithIntent {
  id: number;
  type: string;
  market: string;
  data: string;
  signature: string;
  slot: number;
  timestamp: number;
  seq: number;
  intent: string | null;
  display_price: number | null;
  viewerIntent: string;
}

/**
 * Query fills for a wallet with viewer-perspective intent labels.
 *
 * If a stored intent exists for the fill's order, use it directly.
 * Otherwise derive intent from the viewer's role (taker/maker) and takerSide.
 */
export function queryFillsWithIntent(wallet: string, limit: number = 50): FillWithIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT e.*, oi.intent, oi.display_price
       FROM events e
       LEFT JOIN order_intents oi
         ON CAST(json_extract(e.data, '$.makerOrderId') AS TEXT) = oi.order_id
         AND e.market = oi.market
         AND oi.wallet = @wallet
       WHERE e.type = 'fill'
         AND (json_extract(e.data, '$.taker') = @wallet
              OR json_extract(e.data, '$.maker') = @wallet)
       ORDER BY e.timestamp DESC
       LIMIT @limit`,
    )
    .all({ wallet, limit }) as (EventRow & { intent: string | null; display_price: number | null })[];

  return rows.map((row) => {
    const data = JSON.parse(row.data);
    const isTaker = data.taker === wallet;
    const takerSide = data.takerSide as number;
    const makerSide = data.makerSide as number;

    let viewerIntent: string;
    if (row.intent && data[isTaker ? 'taker' : 'maker'] === wallet) {
      // Stored intent matches viewer's order
      viewerIntent = row.intent;
    } else if (isTaker) {
      // Derive from taker's side
      viewerIntent = { 0: "buy_yes", 1: "sell_yes", 2: "sell_no" }[takerSide] ?? "unknown";
    } else {
      // Derive from maker's own resting side (makerSide is authoritative)
      viewerIntent = { 0: "buy_yes", 1: "sell_yes", 2: "sell_no" }[makerSide] ?? "unknown";
    }

    return {
      id: row.id!,
      type: row.type,
      market: row.market,
      data: row.data,
      signature: row.signature,
      slot: row.slot,
      timestamp: row.timestamp,
      seq: row.seq,
      intent: row.intent,
      display_price: row.display_price,
      viewerIntent,
    };
  });
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
