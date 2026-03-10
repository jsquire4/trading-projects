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
} from "./db.js";

const log = createLogger("event-indexer:api");

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const headers = corsHeaders();
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

  if (limit < 0 || offset < 0 || isNaN(limit) || isNaN(offset)) {
    jsonResponse(res, 400, { error: "Invalid limit or offset" });
    return;
  }

  const events = queryEvents({ market, type, limit, offset });
  jsonResponse(res, 200, { events, count: events.length, limit, offset });
}

function handleLatest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const events = getLatestEvents(20);
  jsonResponse(res, 200, { events });
}

function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const checkpoint = getCheckpoint();
  const eventCount = getEventCount();
  jsonResponse(res, 200, {
    status: "ok",
    lastSlot: checkpoint?.last_slot ?? null,
    lastSignature: checkpoint?.last_signature ?? null,
    eventCount,
  });
}

export function startApiServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      const headers = corsHeaders();
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      jsonResponse(res, 405, { error: "Method not allowed" });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://localhost:${port}`);
    } catch {
      jsonResponse(res, 400, { error: "Invalid URL" });
      return;
    }

    const pathname = url.pathname;

    try {
      if (pathname === "/api/events/latest") {
        handleLatest(req, res);
      } else if (pathname === "/api/events") {
        handleEvents(req, res, url);
      } else if (pathname === "/api/health") {
        handleHealth(req, res);
      } else {
        jsonResponse(res, 404, { error: "Not found" });
      }
    } catch (err) {
      log.error("Request handler error", {
        path: pathname,
        error: String(err),
      });
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(port, () => {
    log.info(`API server listening on port ${port}`);
  });

  return server;
}
