/**
 * REST API Server
 *
 * Lightweight HTTP server using Node's built-in http module.
 * Serves event queries for the frontend History page.
 */

import http from "node:http";
import { createLogger } from "../../shared/src/alerting.js";
import {
  queryEvents,
  getLatestEvents,
  getEventCount,
  getCheckpoint,
  queryCostBasis,
  queryMarketVwaps,
  insertOrderIntent,
  queryFillsWithIntent,
  queryPortfolioSnapshot,
  queryPortfolioHistory,
  upsertMarketTicker,
  computeMeridianIndex,
  computeConvictionScores,
  computeConvictionLeaders,
  computeSmartMoney,
  queryIndexSnapshots,
} from "./db.js";

const log = createLogger("event-indexer:api");

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function getAllowedOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = getAllowedOrigin(req);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
  // Only set Access-Control-Allow-Origin when the origin is explicitly allowed
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
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
  if (!wallet || !/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
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

function handleOrderIntent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed" }, req);
    return;
  }

  let body = "";
  let bodyOverflow = false;
  const MAX_BODY_SIZE = 4096; // 4KB — order intent payloads are ~200 bytes
  req.on("data", (chunk: Buffer) => {
    if (bodyOverflow) return;
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      bodyOverflow = true;
      body = ""; // release accumulated data
      jsonResponse(res, 413, { error: "Request body too large" }, req);
      return;
    }
  });
  req.on("end", () => {
    if (bodyOverflow) return;
    try {
      const parsed = JSON.parse(body);
      const { orderId, market, wallet, intent, displayPrice } = parsed;

      // Validate required fields
      if (orderId == null || !market || !wallet || !intent || displayPrice === undefined) {
        jsonResponse(res, 400, { error: "Missing required fields: orderId, market, wallet, intent, displayPrice" }, req);
        return;
      }

      const VALID_INTENTS = ["buy_yes", "sell_yes", "buy_no", "sell_no"];
      if (!VALID_INTENTS.includes(intent)) {
        jsonResponse(res, 400, { error: "Invalid intent. Must be one of: buy_yes, sell_yes, buy_no, sell_no" }, req);
        return;
      }

      const price = parseInt(String(displayPrice), 10);
      if (isNaN(price) || price < 1 || price > 99) {
        jsonResponse(res, 400, { error: "displayPrice must be between 1 and 99" }, req);
        return;
      }

      if (!/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(market) || !/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
        jsonResponse(res, 400, { error: "Invalid market or wallet address" }, req);
        return;
      }

      insertOrderIntent({
        order_id: String(orderId),
        market,
        wallet,
        intent,
        display_price: price,
      });

      jsonResponse(res, 200, { ok: true }, req);
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON body" }, req);
    }
  });
}

function handleFillsWithIntent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const params = parseQuery(url);
  const wallet = params.wallet;
  if (!wallet || !/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
    jsonResponse(res, 400, { error: "Invalid or missing wallet address" }, req);
    return;
  }
  const limit = params.limit ? parseInt(params.limit, 10) : 50;
  if (isNaN(limit) || limit < 1 || limit > 500) {
    jsonResponse(res, 400, { error: "Invalid limit" }, req);
    return;
  }
  const fills = queryFillsWithIntent(wallet, limit);
  jsonResponse(res, 200, { fills }, req);
}

function handlePortfolioSnapshot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const params = parseQuery(url);
  const wallet = params.wallet;
  if (!wallet || !/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
    jsonResponse(res, 400, { error: "Invalid or missing wallet address" }, req);
    return;
  }
  const positions = queryPortfolioSnapshot(wallet);
  jsonResponse(res, 200, { wallet, positions }, req);
}

function handlePortfolioHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const params = parseQuery(url);
  const wallet = params.wallet;
  if (!wallet || !/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
    jsonResponse(res, 400, { error: "Invalid or missing wallet address" }, req);
    return;
  }
  const days = params.days ? parseInt(params.days, 10) : 30;
  if (isNaN(days) || days < 1 || days > 365) {
    jsonResponse(res, 400, { error: "Invalid days parameter (must be 1-365)" }, req);
    return;
  }
  const dailySummaries = queryPortfolioHistory(wallet, days);
  jsonResponse(res, 200, { wallet, dailySummaries }, req);
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

    if (req.method !== "GET" && req.method !== "POST") {
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
      if (pathname === "/api/portfolio/snapshot") {
        handlePortfolioSnapshot(req, res, url);
      } else if (pathname === "/api/portfolio/history") {
        handlePortfolioHistory(req, res, url);
      } else if (pathname === "/api/order-intent") {
        handleOrderIntent(req, res);
      } else if (pathname === "/api/events/fills") {
        handleFillsWithIntent(req, res, url);
      } else if (pathname === "/api/events/cost-basis") {
        handleCostBasis(req, res, url);
      } else if (pathname === "/api/events/market-vwaps") {
        handleMarketVwaps(req, res);
      } else if (pathname === "/api/events/latest") {
        handleLatest(req, res);
      } else if (pathname === "/api/events") {
        handleEvents(req, res, url);
      } else if (pathname === "/api/health") {
        handleHealth(req, res);

      // ---- Signals endpoints ----
      } else if (pathname === "/api/index/current") {
        jsonResponse(res, 200, computeMeridianIndex(), req);
      } else if (pathname === "/api/index/history") {
        const p = parseQuery(url);
        const period = p.period === "daily" ? "daily" : "intraday";
        const days = Math.min(90, Math.max(1, parseInt(p.days ?? "7", 10) || 7));
        const periodSecs = period === "intraday" ? 24 * 3600 : days * 86400;
        jsonResponse(res, 200, { snapshots: queryIndexSnapshots({ periodSeconds: periodSecs }), period, days }, req);
      } else if (pathname === "/api/conviction/leaders") {
        const p = parseQuery(url);
        const limit = Math.min(100, Math.max(1, parseInt(p.limit ?? "20", 10) || 20));
        jsonResponse(res, 200, { leaders: computeConvictionLeaders(limit) }, req);
      } else if (pathname.startsWith("/api/conviction/")) {
        const wallet = pathname.slice("/api/conviction/".length);
        if (!/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(wallet)) {
          jsonResponse(res, 400, { error: "Invalid wallet address" }, req);
        } else {
          const results = computeConvictionScores(wallet);
          jsonResponse(res, 200, results[0] ?? { wallet, score: 0, trades: 0, winRate: 0, byTicker: [] }, req);
        }
      } else if (pathname === "/api/signals/smart-money") {
        jsonResponse(res, 200, { signals: computeSmartMoney() }, req);
      } else if (pathname === "/api/market-tickers" && req.method === "POST") {
        let body = "";
        let overflow = false;
        req.on("data", (chunk: Buffer) => {
          if (overflow) return;
          body += chunk.toString();
          if (body.length > 4096) { overflow = true; jsonResponse(res, 413, { error: "Body too large" }, req); }
        });
        req.on("error", () => { if (!overflow) jsonResponse(res, 400, { error: "Request stream error" }, req); });
        req.on("end", () => {
          if (overflow) return;
          try {
            const { market, ticker, strike, close_unix } = JSON.parse(body);
            if (!market || !ticker) {
              jsonResponse(res, 400, { error: "Missing market or ticker" }, req);
              return;
            }
            if (!/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(market)) {
              jsonResponse(res, 400, { error: "Invalid market address" }, req);
              return;
            }
            if (!/^[A-Z]{1,8}$/.test(String(ticker))) {
              jsonResponse(res, 400, { error: "Invalid ticker format" }, req);
              return;
            }
            upsertMarketTicker({ market, ticker: String(ticker), strike: Number(strike ?? 0), close_unix: Number(close_unix ?? 0) });
            jsonResponse(res, 200, { ok: true }, req);
          } catch {
            jsonResponse(res, 400, { error: "Invalid JSON" }, req);
          }
        });

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
