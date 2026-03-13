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
