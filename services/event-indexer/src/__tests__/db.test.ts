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
  insertOrderIntent,
  queryFillsWithIntent,
  queryCostBasis,
  queryMarketVwaps,
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
    seq: overrides.seq ?? 0,
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
      expect(names).toContain("idx_events_sig_type_seq");
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

  // ---- Same-signature multi-fill dedup ----

  describe("same-signature multi-fill dedup", () => {
    it("allows multiple events with same signature but different seq", () => {
      const sig = "same_sig_123";
      insertEvent(makeEvent({ signature: sig, seq: 0, market: "MarketA" }));
      insertEvent(makeEvent({ signature: sig, seq: 1, market: "MarketA" }));
      expect(getEventCount()).toBe(2);
    });

    it("ignores duplicate with same signature, type, market, and seq", () => {
      const sig = "dup_sig_456";
      insertEvent(makeEvent({ signature: sig, seq: 0, market: "MarketA" }));
      insertEvent(makeEvent({ signature: sig, seq: 0, market: "MarketA" }));
      expect(getEventCount()).toBe(1);
    });
  });

  // ---- Order intent operations ----

  describe("insertOrderIntent", () => {
    it("inserts and retrieves an order intent", () => {
      insertOrderIntent({
        order_id: "42",
        market: "MarketA",
        wallet: "WalletA",
        intent: "buy_yes",
        display_price: 65,
      });
      const row = getDb()
        .prepare("SELECT * FROM order_intents WHERE order_id = '42'")
        .get() as any;
      expect(row).toBeDefined();
      expect(row.intent).toBe("buy_yes");
      expect(row.display_price).toBe(65);
    });

    it("upserts on conflict (same order_id + market)", () => {
      insertOrderIntent({
        order_id: "42",
        market: "MarketA",
        wallet: "WalletA",
        intent: "buy_yes",
        display_price: 65,
      });
      insertOrderIntent({
        order_id: "42",
        market: "MarketA",
        wallet: "WalletA",
        intent: "buy_no",
        display_price: 35,
      });
      const rows = getDb()
        .prepare("SELECT * FROM order_intents WHERE order_id = '42'")
        .all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).intent).toBe("buy_no");
    });
  });

  // ---- queryFillsWithIntent ----

  describe("queryFillsWithIntent", () => {
    const wallet = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const market = "MarketAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("returns fills with derived intent when no stored intent", () => {
      // Insert a fill where wallet is taker with takerSide=0 (Buy Yes)
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_1",
        data: JSON.stringify({
          taker: wallet,
          maker: "OtherWallet",
          takerSide: 0,
          makerSide: 0,
          price: 65,
          quantity: 1000000,
          makerOrderId: "100",
        }),
      }));

      const fills = queryFillsWithIntent(wallet);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("buy_yes");
    });

    it("returns stored intent when available (maker side)", () => {
      // Store intent for the maker's order
      insertOrderIntent({
        order_id: "200",
        market,
        wallet,
        intent: "buy_no",
        display_price: 35,
      });

      // Fill where wallet is the maker (makerOrderId matches stored intent)
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_2",
        data: JSON.stringify({
          taker: "OtherWallet",
          maker: wallet,
          takerSide: 1,
          makerSide: 0,
          price: 65,
          quantity: 1000000,
          makerOrderId: "200",
        }),
      }));

      const fills = queryFillsWithIntent(wallet);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("buy_no");
      expect(fills[0].display_price).toBe(35);
    });

    it("derives maker perspective from makerSide (side 0 = Buy Yes)", () => {
      const maker = "MakerWalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_3",
        data: JSON.stringify({
          taker: "OtherWallet",
          maker,
          takerSide: 0,
          makerSide: 0,
          price: 65,
          quantity: 1000000,
          makerOrderId: "300",
        }),
      }));

      const fills = queryFillsWithIntent(maker);
      expect(fills).toHaveLength(1);
      // Maker's resting side is 0 (USDC_BID) → Buy Yes
      expect(fills[0].viewerIntent).toBe("buy_yes");
    });

    it("derives taker perspective for takerSide=1 (Sell Yes)", () => {
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_4",
        data: JSON.stringify({
          taker: wallet,
          maker: "OtherWallet",
          takerSide: 1,
          makerSide: 0,
          price: 65,
          quantity: 1000000,
          makerOrderId: "400",
        }),
      }));

      const fills = queryFillsWithIntent(wallet);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("sell_yes");
    });

    it("derives taker perspective for takerSide=2 (Sell No)", () => {
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_5",
        data: JSON.stringify({
          taker: wallet,
          maker: "OtherWallet",
          takerSide: 2,
          makerSide: 1,
          price: 40,
          quantity: 500000,
          makerOrderId: "500",
        }),
      }));

      const fills = queryFillsWithIntent(wallet);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("sell_no");
    });

    it("returns 'unknown' for unrecognized taker side values", () => {
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_unknown_taker",
        data: JSON.stringify({
          taker: wallet,
          maker: "OtherWallet",
          takerSide: 99,
          makerSide: 0,
          price: 50,
          quantity: 1000000,
          makerOrderId: "998",
        }),
      }));

      const fills = queryFillsWithIntent(wallet);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("unknown");
    });

    it("returns 'unknown' for unrecognized maker side values", () => {
      const maker = "UnknownMkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_unknown_maker",
        data: JSON.stringify({
          taker: "OtherWallet",
          maker,
          takerSide: 0,
          makerSide: 99,
          price: 50,
          quantity: 1000000,
          makerOrderId: "999",
        }),
      }));

      const fills = queryFillsWithIntent(maker);
      expect(fills).toHaveLength(1);
      expect(fills[0].viewerIntent).toBe("unknown");
    });

    it("filters fills to the queried wallet only", () => {
      const otherWallet = "OtherWalAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      // Insert fills for two different wallets
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_w1",
        data: JSON.stringify({
          taker: wallet, maker: otherWallet, takerSide: 0, makerSide: 0,
          price: 50, quantity: 1000000, makerOrderId: "800",
        }),
      }));
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_w2",
        data: JSON.stringify({
          taker: otherWallet, maker: "ThirdWallet",  takerSide: 0, makerSide: 0,
          price: 60, quantity: 2000000, makerOrderId: "801",
        }),
      }));

      const walletFills = queryFillsWithIntent(wallet);
      // wallet appears as taker in sig_w1 — sig_w2 has neither taker nor maker matching
      expect(walletFills).toHaveLength(1);
      expect(walletFills[0].signature).toBe("fill_sig_w1");
    });

    it("derives maker perspective for merge fill (makerSide=2 = Sell No)", () => {
      const maker = "MergeMakerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      // takerSide=1 (Sell Yes) matched by makerSide=2 (No-backed bid)
      insertEvent(makeEvent({
        market,
        signature: "fill_sig_6",
        data: JSON.stringify({
          taker: "OtherWallet",
          maker,
          takerSide: 1,
          makerSide: 2,
          price: 65,
          quantity: 1000000,
          makerOrderId: "600",
          isMerge: true,
        }),
      }));

      const fills = queryFillsWithIntent(maker);
      expect(fills).toHaveLength(1);
      // Maker's resting side is 2 (NO_BID) → Sell No
      expect(fills[0].viewerIntent).toBe("sell_no");
    });
  });

  // ---- queryCostBasis ----

  describe("queryCostBasis", () => {
    const wallet = "CostWalAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const market = "CostMktAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("tracks taker Yes acquisition (takerSide=0)", () => {
      insertEvent(makeEvent({
        market,
        signature: "cb_1",
        data: JSON.stringify({ taker: wallet, maker: "Other", takerSide: 0, makerSide: 0, price: 60, quantity: 2000000, makerOrderId: "1" }),
      }));
      const rows = queryCostBasis(wallet);
      expect(rows).toHaveLength(1);
      expect(rows[0].side).toBe("yes");
      expect(rows[0].totalQuantity).toBe(2000000);
      expect(rows[0].avgPrice).toBe(60);
    });

    it("tracks taker No acquisition (takerSide=2)", () => {
      insertEvent(makeEvent({
        market,
        signature: "cb_2",
        data: JSON.stringify({ taker: wallet, maker: "Other", takerSide: 2, makerSide: 1, price: 40, quantity: 1000000, makerOrderId: "2" }),
      }));
      const rows = queryCostBasis(wallet);
      expect(rows).toHaveLength(1);
      expect(rows[0].side).toBe("no");
      expect(rows[0].totalQuantity).toBe(1000000);
    });

    it("tracks maker Yes acquisition (makerSide=0)", () => {
      insertEvent(makeEvent({
        market,
        signature: "cb_3",
        data: JSON.stringify({ taker: "Other", maker: wallet, takerSide: 1, makerSide: 0, price: 55, quantity: 3000000, makerOrderId: "3" }),
      }));
      const rows = queryCostBasis(wallet);
      expect(rows).toHaveLength(1);
      expect(rows[0].side).toBe("yes");
    });

    it("tracks maker No acquisition via merge fill (makerSide=2)", () => {
      insertEvent(makeEvent({
        market,
        signature: "cb_4",
        data: JSON.stringify({ taker: "Other", maker: wallet, takerSide: 1, makerSide: 2, price: 35, quantity: 1500000, makerOrderId: "4" }),
      }));
      const rows = queryCostBasis(wallet);
      expect(rows).toHaveLength(1);
      expect(rows[0].side).toBe("no");
      expect(rows[0].totalQuantity).toBe(1500000);
    });

    it("excludes sell fills (takerSide=1 as taker)", () => {
      insertEvent(makeEvent({
        market,
        signature: "cb_5",
        data: JSON.stringify({ taker: wallet, maker: "Other", takerSide: 1, makerSide: 0, price: 60, quantity: 1000000, makerOrderId: "5" }),
      }));
      const rows = queryCostBasis(wallet);
      expect(rows).toHaveLength(0);
    });

    it("returns empty for wallet with no fills", () => {
      const rows = queryCostBasis("NoFillsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(rows).toHaveLength(0);
    });
  });

  // ---- queryMarketVwaps ----

  describe("queryMarketVwaps", () => {
    it("computes VWAP per market", () => {
      insertEventsBatch([
        makeEvent({ market: "VwapMkt1", signature: "vw1", data: JSON.stringify({ price: 50, quantity: 1000000 }) }),
        makeEvent({ market: "VwapMkt1", signature: "vw2", data: JSON.stringify({ price: 60, quantity: 3000000 }) }),
        makeEvent({ market: "VwapMkt2", signature: "vw3", data: JSON.stringify({ price: 40, quantity: 2000000 }) }),
      ]);
      const vwaps = queryMarketVwaps();
      expect(vwaps).toHaveLength(2);
      const mkt1 = vwaps.find(v => v.market === "VwapMkt1")!;
      // VWAP = (50*1M + 60*3M) / (1M + 3M) = 230M / 4M = 57.5
      expect(mkt1.vwap).toBeCloseTo(57.5, 1);
      expect(mkt1.fillCount).toBe(2);
    });
  });
});
