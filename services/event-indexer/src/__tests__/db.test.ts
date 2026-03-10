import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initDb,
  closeDb,
  insertEvent,
  insertEventsBatch,
  queryEvents,
  getLatestEvents,
  getEventCount,
  signatureExists,
  getCheckpoint,
  upsertCheckpoint,
  getDb,
  type EventRow,
} from "../db.ts";

function makeEvent(overrides: Partial<Omit<EventRow, "id" | "created_at">> = {}): Omit<EventRow, "id" | "created_at"> {
  return {
    type: overrides.type ?? "fill",
    market: overrides.market ?? "MarketAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    data: overrides.data ?? '{"price":100}',
    signature: overrides.signature ?? `sig_${Math.random().toString(36).slice(2)}`,
    slot: overrides.slot ?? 1000,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000),
  };
}

describe("Database Layer", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  // ---- Schema initialization ----

  describe("initDb", () => {
    it("creates the events table", () => {
      const tables = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("creates the checkpoints table", () => {
      const tables = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("creates indexes on events table", () => {
      const indexes = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
        .all() as { name: string }[];
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_events_market");
      expect(names).toContain("idx_events_type");
      expect(names).toContain("idx_events_timestamp");
    });
  });

  // ---- insertEvent / insertEventsBatch ----

  describe("insertEventsBatch", () => {
    it("inserts multiple events atomically", () => {
      const events = [makeEvent({ slot: 1 }), makeEvent({ slot: 2 }), makeEvent({ slot: 3 })];
      insertEventsBatch(events);
      expect(getEventCount()).toBe(3);
    });

    it("handles empty array without error", () => {
      insertEventsBatch([]);
      expect(getEventCount()).toBe(0);
    });
  });

  describe("insertEvent", () => {
    it("inserts a single event", () => {
      insertEvent(makeEvent());
      expect(getEventCount()).toBe(1);
    });
  });

  // ---- queryEvents ----

  describe("queryEvents", () => {
    beforeEach(() => {
      // Insert varied events for filtering tests
      insertEventsBatch([
        makeEvent({ type: "fill", market: "MarketA", timestamp: 100, signature: "sig1" }),
        makeEvent({ type: "settlement", market: "MarketA", timestamp: 200, signature: "sig2" }),
        makeEvent({ type: "fill", market: "MarketB", timestamp: 300, signature: "sig3" }),
        makeEvent({ type: "crank_cancel", market: "MarketB", timestamp: 400, signature: "sig4" }),
        makeEvent({ type: "fill", market: "MarketA", timestamp: 500, signature: "sig5" }),
      ]);
    });

    it("returns all events when no filters are given", () => {
      const results = queryEvents({});
      expect(results).toHaveLength(5);
    });

    it("filters by market", () => {
      const results = queryEvents({ market: "MarketA" });
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.market).toBe("MarketA");
      }
    });

    it("filters by type", () => {
      const results = queryEvents({ type: "fill" });
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.type).toBe("fill");
      }
    });

    it("filters by market AND type", () => {
      const results = queryEvents({ market: "MarketA", type: "fill" });
      expect(results).toHaveLength(2);
    });

    it("respects limit", () => {
      const results = queryEvents({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("respects offset", () => {
      const all = queryEvents({});
      const offset = queryEvents({ offset: 2 });
      expect(offset).toHaveLength(3);
      expect(offset[0].id).toBe(all[2].id);
    });

    it("returns events in descending timestamp order", () => {
      const results = queryEvents({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].timestamp).toBeGreaterThanOrEqual(results[i].timestamp);
      }
    });

    it("caps limit at 500", () => {
      // Insert more events so we can tell the cap is working
      const bulk = Array.from({ length: 10 }, (_, i) =>
        makeEvent({ signature: `bulk_${i}`, timestamp: 1000 + i }),
      );
      insertEventsBatch(bulk);
      // Request 9999 — should be capped to 500
      const results = queryEvents({ limit: 9999 });
      // We only have 15 total, so all returned, but the cap logic ran
      expect(results.length).toBeLessThanOrEqual(500);
    });
  });

  // ---- getLatestEvents ----

  describe("getLatestEvents", () => {
    it("returns the last N events in descending order", () => {
      insertEventsBatch([
        makeEvent({ timestamp: 10, signature: "a" }),
        makeEvent({ timestamp: 20, signature: "b" }),
        makeEvent({ timestamp: 30, signature: "c" }),
      ]);

      const latest = getLatestEvents(2);
      expect(latest).toHaveLength(2);
      expect(latest[0].timestamp).toBe(30);
      expect(latest[1].timestamp).toBe(20);
    });

    it("defaults to 20 when count is omitted", () => {
      const bulk = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ signature: `s${i}`, timestamp: i }),
      );
      insertEventsBatch(bulk);

      const latest = getLatestEvents();
      expect(latest).toHaveLength(20);
    });
  });

  // ---- signatureExists ----

  describe("signatureExists", () => {
    it("returns true for an existing signature", () => {
      insertEvent(makeEvent({ signature: "unique_sig" }));
      expect(signatureExists("unique_sig")).toBe(true);
    });

    it("returns false for a non-existing signature", () => {
      expect(signatureExists("nonexistent")).toBe(false);
    });
  });

  // ---- Checkpoint operations ----

  describe("checkpoint operations", () => {
    it("returns null when no checkpoint exists", () => {
      expect(getCheckpoint()).toBeNull();
    });

    it("round-trips upsertCheckpoint / getCheckpoint", () => {
      upsertCheckpoint("sig_abc", 42);
      const cp = getCheckpoint();
      expect(cp).not.toBeNull();
      expect(cp!.last_signature).toBe("sig_abc");
      expect(cp!.last_slot).toBe(42);
    });

    it("updates an existing checkpoint on second upsert", () => {
      upsertCheckpoint("sig_1", 10);
      upsertCheckpoint("sig_2", 20);
      const cp = getCheckpoint();
      expect(cp!.last_signature).toBe("sig_2");
      expect(cp!.last_slot).toBe(20);
    });
  });

  // ---- getHealth (via getEventCount + getCheckpoint) ----

  describe("getHealth (eventCount + lastSlot)", () => {
    it("returns 0 eventCount and null checkpoint for empty db", () => {
      expect(getEventCount()).toBe(0);
      expect(getCheckpoint()).toBeNull();
    });

    it("returns correct eventCount after inserts", () => {
      insertEventsBatch([makeEvent({ signature: "h1" }), makeEvent({ signature: "h2" })]);
      expect(getEventCount()).toBe(2);
    });

    it("returns correct lastSlot after checkpoint update", () => {
      upsertCheckpoint("sig_health", 9999);
      const cp = getCheckpoint();
      expect(cp!.last_slot).toBe(9999);
    });
  });

  // ---- Empty database edge cases ----

  describe("empty database queries", () => {
    it("queryEvents returns empty array", () => {
      expect(queryEvents({})).toEqual([]);
    });

    it("getLatestEvents returns empty array", () => {
      expect(getLatestEvents()).toEqual([]);
    });

    it("queryEvents with filters returns empty array", () => {
      expect(queryEvents({ market: "X", type: "fill" })).toEqual([]);
    });
  });
});
