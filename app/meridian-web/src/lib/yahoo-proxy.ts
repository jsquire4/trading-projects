/**
 * Server-side Yahoo Finance proxy with TTL caching.
 *
 * All /api/market-data/* routes consume from this module via market-data-proxy.
 * No API key required — Yahoo Finance is free.
 */

import YahooFinance from "yahoo-finance2";

// Module-level singleton
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Quote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  prevclose: number;
  volume: number;
  change: number;
  change_percentage: number;
}

export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 60_000; // 60 seconds

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// Public API (server-side only)
// ---------------------------------------------------------------------------

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const key = `quotes:${symbols.sort().join(",")}`;
  const cached = getCached<Quote[]>(key);
  if (cached) return cached;

  const results: Quote[] = [];

  for (const symbol of symbols) {
    try {
      const q = await yf.quote(symbol);
      if (!q) continue;

      const last = q.regularMarketPrice ?? 0;
      const prevclose = q.regularMarketPreviousClose ?? 0;

      results.push({
        symbol: q.symbol ?? symbol,
        last,
        bid: q.bid ?? last,
        ask: q.ask ?? last,
        prevclose,
        volume: q.regularMarketVolume ?? 0,
        change: q.regularMarketChange ?? 0,
        change_percentage: q.regularMarketChangePercent ?? 0,
      });
    } catch {
      // Skip invalid symbols
    }
  }

  setCache(key, results);
  return results;
}

export async function getHistory(
  symbol: string,
  start?: string,
  end?: string,
): Promise<OHLCVBar[]> {
  const key = `history:${symbol}:${start ?? ""}:${end ?? ""}`;
  const cached = getCached<OHLCVBar[]>(key);
  if (cached) return cached;

  const period1 = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const period2 = end ? new Date(end) : new Date();

  try {
    const result = await yf.chart(symbol, {
      period1,
      period2,
      interval: "1d" as const,
    });

    if (!result?.quotes) return [];

    const bars: OHLCVBar[] = result.quotes
      .filter((bar) => bar.close !== null && bar.close !== undefined)
      .map((bar) => ({
        date: new Date(bar.date).toISOString().slice(0, 10),
        open: bar.open ?? 0,
        high: bar.high ?? 0,
        low: bar.low ?? 0,
        close: bar.close ?? 0,
        volume: bar.volume ?? 0,
      }));

    setCache(key, bars);
    return bars;
  } catch {
    return [];
  }
}

/**
 * Get today's date in YYYY-MM-DD format (ET timezone).
 */
export function getTodayExpiration(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}
