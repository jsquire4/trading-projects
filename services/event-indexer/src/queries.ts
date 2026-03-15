/**
 * Event CRUD, checkpoint operations, and order intent queries.
 *
 * Split from db.ts for maintainability.
 */

import type Database from "better-sqlite3";
import { getDb, type EventRow, type Checkpoint } from "./db.js";

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

export function resetInsertStmt(): void {
  _insertEvent = null;
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

export function signatureExists(signature: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM events WHERE signature = ? LIMIT 1")
    .get(signature);
  return row !== undefined;
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
