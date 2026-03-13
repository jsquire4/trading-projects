import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  initDb,
  closeDb,
  insertEventsBatch,
  upsertCheckpoint,
  insertOrderIntent,
  getDb,
} from "../db.ts";
import { startApiServer } from "../api.ts";

let server: http.Server;
let baseUrl: string;

/** Helper: make a GET request and return parsed JSON + headers + status. */
async function get(path: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode!, headers: res.headers, body: data });
        }
      });
      res.on("error", reject);
    });
  });
}

/** Helper: make a POST request and return parsed JSON + status. */
async function post(baseUrl: string, path: string, body: unknown): Promise<{
  status: number;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode!, body: buf }); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("API Server", () => {
  beforeAll(async () => {
    // Use in-memory database
    initDb(":memory:");

    // Start server on port 0 to get a random available port
    server = startApiServer(0);

    await new Promise<void>((resolve) => {
      server.once("listening", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
  });

  // Seed data before running the suite (runs once because beforeAll already set up db)
  beforeAll(() => {
    insertEventsBatch([
      { type: "fill", market: "MktA", data: '{"p":1}', signature: "s1", slot: 100, timestamp: 1000 },
      { type: "fill", market: "MktA", data: '{"p":2}', signature: "s2", slot: 101, timestamp: 1001 },
      { type: "settlement", market: "MktA", data: '{"p":3}', signature: "s3", slot: 102, timestamp: 1002 },
      { type: "fill", market: "MktB", data: '{"p":4}', signature: "s4", slot: 103, timestamp: 1003 },
      { type: "crank_cancel", market: "MktB", data: '{"p":5}', signature: "s5", slot: 104, timestamp: 1004 },
    ]);
    upsertCheckpoint("s5", 104);
  });

  // ---- GET /api/events ----

  describe("GET /api/events", () => {
    it("returns a JSON array of events", async () => {
      const { status, body } = await get("/api/events");
      expect(status).toBe(200);
      expect(body.events).toBeInstanceOf(Array);
      expect(body.events.length).toBe(5);
    });

    it("filters by market", async () => {
      const { body } = await get("/api/events?market=MktA");
      expect(body.events.length).toBe(3);
      for (const e of body.events) {
        expect(e.market).toBe("MktA");
      }
    });

    it("filters by type", async () => {
      const { body } = await get("/api/events?type=fill");
      expect(body.events.length).toBe(3);
      for (const e of body.events) {
        expect(e.type).toBe("fill");
      }
    });

    it("respects limit", async () => {
      const { body } = await get("/api/events?limit=2");
      expect(body.events.length).toBe(2);
      expect(body.limit).toBe(2);
    });

    it("respects offset", async () => {
      const { body } = await get("/api/events?offset=3");
      expect(body.events.length).toBe(2);
      expect(body.offset).toBe(3);
    });

    it("returns 400 for negative limit", async () => {
      const { status, body } = await get("/api/events?limit=-1");
      expect(status).toBe(400);
      expect(body.error).toBeDefined();
    });
  });

  // ---- GET /api/events/latest ----

  describe("GET /api/events/latest", () => {
    it("returns the last 20 events (or fewer if less exist)", async () => {
      const { status, body } = await get("/api/events/latest");
      expect(status).toBe(200);
      expect(body.events).toBeInstanceOf(Array);
      // We have 5 events total, so should get 5
      expect(body.events.length).toBe(5);
    });

    it("returns events in descending timestamp order", async () => {
      const { body } = await get("/api/events/latest");
      for (let i = 1; i < body.events.length; i++) {
        expect(body.events[i - 1].timestamp).toBeGreaterThanOrEqual(body.events[i].timestamp);
      }
    });
  });

  // ---- GET /api/health ----

  describe("GET /api/health", () => {
    it("returns status, lastSlot, and eventCount", async () => {
      const { status, body } = await get("/api/health");
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.lastSlot).toBe(104);
      expect(body.eventCount).toBe(5);
    });
  });

  // ---- CORS ----

  describe("CORS headers", () => {
    it("includes Access-Control-Allow-Origin for allowed origins", async () => {
      // Send request with an allowed origin
      const { headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/events`, { headers: { Origin: "http://localhost:3000" } }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(data) }));
          res.on("error", reject);
        });
        req.on("error", reject);
      });
      expect(headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });

    it("omits Access-Control-Allow-Origin for disallowed origins", async () => {
      const { headers } = await get("/api/events");
      expect(headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("includes Content-Type: application/json", async () => {
      const { headers } = await get("/api/events");
      expect(headers["content-type"]).toBe("application/json");
    });
  });

  // ---- POST /api/order-intent ----

  describe("POST /api/order-intent", () => {
    const validIntent = {
      orderId: 42,
      market: "Ma22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      wallet: "Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      intent: "buy_yes",
      displayPrice: 65,
    };

    it("stores a valid intent and returns ok", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", validIntent);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("accepts orderId=0 as valid", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { ...validIntent, orderId: 0 });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("rejects missing required fields", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { orderId: 1 });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Missing required fields/);
    });

    it("rejects invalid intent value", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { ...validIntent, intent: "invalid" });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Invalid intent/);
    });

    it("rejects displayPrice out of range", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { ...validIntent, displayPrice: 0 });
      expect(status).toBe(400);
      expect(body.error).toMatch(/displayPrice/);
    });

    it("rejects invalid base58 addresses", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { ...validIntent, market: "!!invalid!!" });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Invalid market or wallet/);
    });

    it("rejects too-short base58 addresses", async () => {
      const { status, body } = await post(baseUrl, "/api/order-intent", { ...validIntent, market: "ABC123" });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Invalid market or wallet/);
    });

    it("returns 413 for oversized request body", async () => {
      const oversized = { ...validIntent, extra: "x".repeat(5000) };
      const { status, body } = await post(baseUrl, "/api/order-intent", oversized);
      expect(status).toBe(413);
      expect(body.error).toMatch(/too large/i);
    });

    it("returns 405 for GET on order-intent endpoint", async () => {
      const { status } = await get("/api/order-intent");
      expect(status).toBe(405);
    });
  });

  // ---- GET /api/events/fills ----

  describe("GET /api/events/fills", () => {
    const wallet = "Fi22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const market = "Fi22Ma22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    beforeAll(() => {
      insertEventsBatch([{
        type: "fill",
        market,
        data: JSON.stringify({ taker: wallet, maker: "Other", takerSide: 0, makerSide: 0, price: 50, quantity: 1000000, makerOrderId: "99" }),
        signature: "fill_api_1",
        slot: 200,
        timestamp: 2000,
      }]);
    });

    it("returns fills with viewerIntent for a wallet", async () => {
      const { status, body } = await get(`/api/events/fills?wallet=${wallet}`);
      expect(status).toBe(200);
      expect(body.fills).toBeInstanceOf(Array);
      expect(body.fills.length).toBe(1);
      expect(body.fills[0].viewerIntent).toBe("buy_yes");
    });

    it("returns 400 when wallet param is missing", async () => {
      const { status, body } = await get("/api/events/fills");
      expect(status).toBe(400);
      expect(body.error).toMatch(/wallet/i);
    });
  });

  // ---- GET /api/events/cost-basis ----

  describe("GET /api/events/cost-basis", () => {
    it("returns cost basis for a valid wallet", async () => {
      const wallet = "Fi22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { status, body } = await get(`/api/events/cost-basis?wallet=${wallet}`);
      expect(status).toBe(200);
      expect(body.costBasis).toBeInstanceOf(Array);
    });

    it("returns 400 when wallet param is missing", async () => {
      const { status, body } = await get("/api/events/cost-basis");
      expect(status).toBe(400);
      expect(body.error).toMatch(/wallet/i);
    });
  });

  // ---- GET /api/events/market-vwaps ----

  describe("GET /api/events/market-vwaps", () => {
    it("returns VWAP data", async () => {
      const { status, body } = await get("/api/events/market-vwaps");
      expect(status).toBe(200);
      expect(body.vwaps).toBeInstanceOf(Array);
    });
  });

  // ---- GET /api/portfolio/snapshot ----

  describe("GET /api/portfolio/snapshot", () => {
    const wallet = "Pf22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const market = "Pf22Ma22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    beforeAll(() => {
      insertEventsBatch([
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "OtherMaker1", takerSide: 0, makerSide: 0, price: 50, quantity: 1000000, makerOrderId: "200" }),
          signature: "pf_snap_1",
          slot: 300,
          timestamp: 3000,
        },
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "OtherMaker2", takerSide: 0, makerSide: 0, price: 60, quantity: 2000000, makerOrderId: "201" }),
          signature: "pf_snap_2",
          slot: 301,
          timestamp: 3001,
        },
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "OtherMaker3", takerSide: 1, makerSide: 1, price: 40, quantity: 500000, makerOrderId: "202" }),
          signature: "pf_snap_3",
          slot: 302,
          timestamp: 3002,
        },
      ]);
    });

    it("returns aggregated positions for a valid wallet", async () => {
      const { status, body } = await get(`/api/portfolio/snapshot?wallet=${wallet}`);
      expect(status).toBe(200);
      expect(body.wallet).toBe(wallet);
      expect(body.positions).toBeInstanceOf(Array);
      expect(body.positions.length).toBe(2); // side 0 and side 1

      const side0 = body.positions.find((p: any) => p.side === 0);
      expect(side0).toBeDefined();
      expect(side0.totalQuantity).toBe(3000000); // 1M + 2M
      expect(side0.fillCount).toBe(2);
      // avgPrice = totalCost / totalQuantity = (1M*50 + 2M*60) / 3M = 170M / 3M ≈ 57
      expect(side0.avgPrice).toBe(57); // Math.round(170000000 / 3000000)

      const side1 = body.positions.find((p: any) => p.side === 1);
      expect(side1).toBeDefined();
      expect(side1.totalQuantity).toBe(500000);
      expect(side1.fillCount).toBe(1);
      expect(side1.avgPrice).toBe(40);
    });

    it("returns empty positions for a wallet with no fills", async () => {
      const emptyWallet = "EmptyWa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { status, body } = await get(`/api/portfolio/snapshot?wallet=${emptyWallet}`);
      expect(status).toBe(200);
      expect(body.wallet).toBe(emptyWallet);
      expect(body.positions).toEqual([]);
    });

    it("returns 400 when wallet param is missing", async () => {
      const { status, body } = await get("/api/portfolio/snapshot");
      expect(status).toBe(400);
      expect(body.error).toMatch(/wallet/i);
    });

    it("returns 400 for invalid wallet address", async () => {
      const { status, body } = await get("/api/portfolio/snapshot?wallet=!!bad!!");
      expect(status).toBe(400);
      expect(body.error).toMatch(/wallet/i);
    });
  });

  // ---- GET /api/portfolio/history ----

  describe("GET /api/portfolio/history", () => {
    const wallet = "Hi22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const market = "Hi22Ma22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    beforeAll(() => {
      // Insert fills with recent timestamps (within last 30 days)
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;
      const twoDaysAgo = now - 86400 * 2;
      insertEventsBatch([
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "HistOther1", takerSide: 0, makerSide: 0, price: 45, quantity: 1000000, makerOrderId: "300" }),
          signature: "pf_hist_1",
          slot: 400,
          timestamp: oneDayAgo,
        },
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "HistOther2", takerSide: 0, makerSide: 0, price: 55, quantity: 2000000, makerOrderId: "301" }),
          signature: "pf_hist_2",
          slot: 401,
          timestamp: oneDayAgo + 60, // same day, a minute later
        },
        {
          type: "fill",
          market,
          data: JSON.stringify({ taker: wallet, maker: "HistOther3", takerSide: 1, makerSide: 1, price: 30, quantity: 500000, makerOrderId: "302" }),
          signature: "pf_hist_3",
          slot: 402,
          timestamp: twoDaysAgo,
        },
      ]);
    });

    it("returns daily summaries for a valid wallet", async () => {
      const { status, body } = await get(`/api/portfolio/history?wallet=${wallet}`);
      expect(status).toBe(200);
      expect(body.wallet).toBe(wallet);
      expect(body.dailySummaries).toBeInstanceOf(Array);
      expect(body.dailySummaries.length).toBe(2); // 2 distinct days

      // Summaries should be ordered by date ascending
      expect(body.dailySummaries[0].date < body.dailySummaries[1].date).toBe(true);

      // The more recent day has 2 fills
      const recentDay = body.dailySummaries[1];
      expect(recentDay.fillCount).toBe(2);
      expect(recentDay.totalVolume).toBe(3000000); // 1M + 2M
    });

    it("respects the days parameter", async () => {
      // With days=1, only the most recent day's fills should appear
      const { status, body } = await get(`/api/portfolio/history?wallet=${wallet}&days=1`);
      expect(status).toBe(200);
      expect(body.dailySummaries.length).toBeLessThanOrEqual(1);
    });

    it("defaults to 30 days when days param is omitted", async () => {
      const { status, body } = await get(`/api/portfolio/history?wallet=${wallet}`);
      expect(status).toBe(200);
      expect(body.dailySummaries).toBeInstanceOf(Array);
      // All 2 days of test data are within 30 days
      expect(body.dailySummaries.length).toBe(2);
    });

    it("returns empty summaries for a wallet with no fills", async () => {
      const emptyWallet = "EmptyHi22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { status, body } = await get(`/api/portfolio/history?wallet=${emptyWallet}`);
      expect(status).toBe(200);
      expect(body.wallet).toBe(emptyWallet);
      expect(body.dailySummaries).toEqual([]);
    });

    it("returns 400 when wallet param is missing", async () => {
      const { status, body } = await get("/api/portfolio/history");
      expect(status).toBe(400);
      expect(body.error).toMatch(/wallet/i);
    });

    it("returns 400 for invalid days parameter", async () => {
      const wallet = "Hi22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { status, body } = await get(`/api/portfolio/history?wallet=${wallet}&days=0`);
      expect(status).toBe(400);
      expect(body.error).toMatch(/days/i);
    });

    it("returns 400 for days exceeding 365", async () => {
      const wallet = "Hi22Wa22etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { status, body } = await get(`/api/portfolio/history?wallet=${wallet}&days=500`);
      expect(status).toBe(400);
      expect(body.error).toMatch(/days/i);
    });
  });

  // ---- 404 ----

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const { status, body } = await get("/api/nonexistent");
      expect(status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for root path", async () => {
      const { status } = await get("/");
      expect(status).toBe(404);
    });
  });
});
