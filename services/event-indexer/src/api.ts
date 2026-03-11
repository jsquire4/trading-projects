/**
 * REST API Server
 *
 * Lightweight HTTP server using Node's built-in http module.
 * Serves event queries for the frontend History page.
 */

import http from "node:http";
import { createLogger } from "../../shared/src/alerting.ts";
import {
  queryEvents,
  getLatestEvents,
  getEventCount,
  getCheckpoint,
  queryCostBasis,
  queryMarketVwaps,
} from "./db.js";

const log = createLogger("event-indexer:api");

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function getAllowedOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return "";
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(req),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  req?: http.IncomingMessage,
): void {
  const fakeReq = req ?? ({ headers: {} } as http.IncomingMessage);
  const headers = corsHeaders(fakeReq);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function parseQuery(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

function handleEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const params = parseQuery(url);

  const market = params.market || undefined;
  const type = params.type || undefined;
  const limit = params.limit ? parseInt(params.limit, 10) : 50;
  const offset = params.offset ? parseInt(params.offset, 10) : 0;

  if (limit < 0 || limit > 500 || offset < 0 || isNaN(limit) || isNaN(offset)) {
    jsonResponse(res, 400, { error: "Invalid limit or offset" }, req);
    return;
  }

  const VALID_TYPES = ["fill", "settlement", "crank_cancel"];
  if (type && !VALID_TYPES.includes(type)) {
    jsonResponse(res, 400, { error: "Invalid event type" }, req);
    return;
  }

  if (market && !/^[A-HJ-NP-Za-km-z1-9]{1,44}$/.test(market)) {
    jsonResponse(res, 400, { error: "Invalid market address" }, req);
    return;
  }

  const events = queryEvents({ market, type, limit, offset });
  jsonResponse(res, 200, { events, count: events.length, limit, offset }, req);
}

function handleLatest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const events = getLatestEvents(20);
  jsonResponse(res, 200, { events }, req);
}

function handleCostBasis(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const params = parseQuery(url);
  const wallet = params.wallet;
  if (!wallet || !/^[A-HJ-NP-Za-km-z1-9]{1,44}$/.test(wallet)) {
    jsonResponse(res, 400, { error: "Invalid or missing wallet address" }, req);
    return;
  }
  const costBasis = queryCostBasis(wallet);
  jsonResponse(res, 200, { costBasis }, req);
}

function handleMarketVwaps(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const vwaps = queryMarketVwaps();
  jsonResponse(res, 200, { vwaps }, req);
}

function handleHealth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const checkpoint = getCheckpoint();
  const eventCount = getEventCount();
  jsonResponse(res, 200, {
    status: "ok",
    lastSlot: checkpoint?.last_slot ?? null,
    eventCount,
  }, req);
}

export function startApiServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      const headers = corsHeaders(req);
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      jsonResponse(res, 405, { error: "Method not allowed" }, req);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://localhost:${port}`);
    } catch {
      jsonResponse(res, 400, { error: "Invalid URL" }, req);
      return;
    }

    const pathname = url.pathname;

    try {
      if (pathname === "/api/events/cost-basis") {
        handleCostBasis(req, res, url);
      } else if (pathname === "/api/events/market-vwaps") {
        handleMarketVwaps(req, res);
      } else if (pathname === "/api/events/latest") {
        handleLatest(req, res);
      } else if (pathname === "/api/events") {
        handleEvents(req, res, url);
      } else if (pathname === "/api/health") {
        handleHealth(req, res);
      } else {
        jsonResponse(res, 404, { error: "Not found" }, req);
      }
    } catch (err) {
      log.error("Request handler error", {
        path: pathname,
      });
      jsonResponse(res, 500, { error: "Internal server error" }, req);
    }
  });

  server.listen(port, () => {
    log.info(`API server listening on port ${port}`);
  });

  return server;
}
