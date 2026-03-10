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
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig_type ON events(signature, type, market);
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

  log.info("Database initialized", { path: resolvedPath });
  return db;
}

// --------------- Event operations ---------------

let _insertEvent: Database.Statement | null = null;

function getInsertStmt(): Database.Statement {
  if (!_insertEvent) {
    _insertEvent = getDb().prepare(`
      INSERT OR IGNORE INTO events (type, market, data, signature, slot, timestamp)
      VALUES (@type, @market, @data, @signature, @slot, @timestamp)
    `);
  }
  return _insertEvent;
}

export function insertEvent(row: Omit<EventRow, "id" | "created_at">): void {
  getInsertStmt().run(row);
}

export function insertEventsBatch(
  rows: Omit<EventRow, "id" | "created_at">[],
): void {
  if (rows.length === 0) return;
  const stmt = getInsertStmt();
  const tx = getDb().transaction((items: typeof rows) => {
    for (const row of items) {
      stmt.run(row);
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
