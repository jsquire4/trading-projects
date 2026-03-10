/**
 * Server-side Tradier API proxy with TTL caching and rate limiting.
 *
 * All /api/tradier/* routes consume from this module. Never call the
 * Tradier API directly from components — always go through these routes.
 */

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

export interface OptionsChainItem {
  symbol: string;
  description: string;
  type: string;
  last: number | null;
  bid: number;
  ask: number;
  strike: number;
  option_type: string;
  expiration_date: string;
  open_interest: number;
  volume: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
    phi: number;
    bid_iv: number;
    mid_iv: number;
    ask_iv: number;
    smv_vol: number;
  };
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
// Rate limiter (token bucket — 60 req/min)
// ---------------------------------------------------------------------------

const BUCKET_CAPACITY = 60;
const REFILL_RATE = 1; // tokens per second

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function refillBucket(): void {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsed * REFILL_RATE);
  lastRefill = now;
}

async function waitForToken(): Promise<void> {
  refillBucket();
  if (tokens >= 1) {
    tokens -= 1;
    return;
  }
  // Wait until a token is available
  const waitMs = ((1 - tokens) / REFILL_RATE) * 1000;
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
  refillBucket();
  tokens -= 1;
}

// ---------------------------------------------------------------------------
// Internal fetch
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.tradier.com";

function getApiKey(): string {
  const key = process.env.TRADIER_API_KEY;
  if (!key) throw new Error("TRADIER_API_KEY environment variable is required");
  return key;
}

async function tradierFetch(path: string, params?: Record<string, string>): Promise<unknown> {
  await waitForToken();

  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    // Don't forward raw Tradier error body to callers — it may contain
    // sensitive details like account info or internal API messages (#18).
    const body = await res.text().catch(() => "");
    console.error(`Tradier API error ${res.status}: ${body}`);
    throw new Error(`Tradier API request failed with status ${res.status}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Public API (server-side only)
// ---------------------------------------------------------------------------

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];

  const key = `quotes:${symbols.sort().join(",")}`;
  const cached = getCached<Quote[]>(key);
  if (cached) return cached;

  const data = (await tradierFetch("/v1/markets/quotes", {
    symbols: symbols.join(","),
  })) as Record<string, unknown>;

  const raw = (data?.quotes as Record<string, unknown>)?.quote;
  if (!raw) return [];

  const quotes: unknown[] = Array.isArray(raw) ? raw : [raw];
  const result: Quote[] = quotes.map((q: any) => ({
    symbol: q.symbol,
    last: q.last ?? 0,
    bid: q.bid ?? 0,
    ask: q.ask ?? 0,
    prevclose: q.prevclose ?? 0,
    volume: q.volume ?? 0,
    change: q.change ?? 0,
    change_percentage: q.change_percentage ?? 0,
  }));

  setCache(key, result);
  return result;
}

export async function getHistory(
  symbol: string,
  start?: string,
  end?: string,
): Promise<OHLCVBar[]> {
  const key = `history:${symbol}:${start ?? ""}:${end ?? ""}`;
  const cached = getCached<OHLCVBar[]>(key);
  if (cached) return cached;

  const params: Record<string, string> = { symbol };
  if (start) params.start = start;
  if (end) params.end = end;

  const data = (await tradierFetch("/v1/markets/history", params)) as Record<string, unknown>;
  const raw = (data?.history as Record<string, unknown>)?.day;
  if (!raw) return [];

  const bars: unknown[] = Array.isArray(raw) ? raw : [raw];
  const result: OHLCVBar[] = bars.map((b: any) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  setCache(key, result);
  return result;
}

export async function getOptionsChain(
  symbol: string,
  expiration: string,
): Promise<OptionsChainItem[]> {
  const key = `options:${symbol}:${expiration}`;
  const cached = getCached<OptionsChainItem[]>(key);
  if (cached) return cached;

  const data = (await tradierFetch("/v1/markets/options/chains", {
    symbol,
    expiration,
    greeks: "true",
  })) as Record<string, unknown>;

  const raw = (data?.options as Record<string, unknown>)?.option;
  if (!raw) return [];

  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const result: OptionsChainItem[] = items.map((o: any) => ({
    symbol: o.symbol,
    description: o.description ?? "",
    type: o.type ?? "",
    last: o.last,
    bid: o.bid ?? 0,
    ask: o.ask ?? 0,
    strike: o.strike,
    option_type: o.option_type,
    expiration_date: o.expiration_date,
    open_interest: o.open_interest ?? 0,
    volume: o.volume ?? 0,
    greeks: o.greeks
      ? {
          delta: o.greeks.delta,
          gamma: o.greeks.gamma,
          theta: o.greeks.theta,
          vega: o.greeks.vega,
          rho: o.greeks.rho,
          phi: o.greeks.phi,
          bid_iv: o.greeks.bid_iv,
          mid_iv: o.greeks.mid_iv,
          ask_iv: o.greeks.ask_iv,
          smv_vol: o.greeks.smv_vol,
        }
      : undefined,
  }));

  setCache(key, result);
  return result;
}

/**
 * Get today's expiration string in YYYY-MM-DD format (ET timezone).
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
