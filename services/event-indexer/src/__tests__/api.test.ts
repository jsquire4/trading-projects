import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  initDb,
  closeDb,
  insertEventsBatch,
  upsertCheckpoint,
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
    it("includes Access-Control-Allow-Origin on responses", async () => {
      const { headers } = await get("/api/events");
      expect(headers["access-control-allow-origin"]).toBeDefined();
    });

    it("includes Content-Type: application/json", async () => {
      const { headers } = await get("/api/events");
      expect(headers["content-type"]).toBe("application/json");
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
