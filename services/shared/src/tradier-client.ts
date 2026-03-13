// ---------------------------------------------------------------------------
// Tradier REST API Client with token-bucket rate limiter
// ---------------------------------------------------------------------------

// ---- Public interfaces ----------------------------------------------------

export interface Quote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  prevclose: number | null;
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

export interface MarketClock {
  date: string;
  description: string;
  state: string;
  timestamp: number;
  next_change: string;
  next_state: string;
}

export interface CalendarDay {
  date: string;
  status: string;
  description: string;
  premarket: { start: string; end: string };
  open: { start: string; end: string };
  postmarket: { start: string; end: string };
}

export interface OptionsChainItem {
  symbol: string;
  description: string;
  exch: string;
  type: string;
  last: number | null;
  change: number | null;
  volume: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bid: number;
  ask: number;
  underlying: string;
  strike: number;
  change_percentage: number | null;
  average_volume: number;
  last_volume: number;
  trade_date: number;
  prevclose: number | null;
  week_52_high: number;
  week_52_low: number;
  bidsize: number;
  bidexch: string;
  bid_date: number;
  asksize: number;
  askexch: string;
  ask_date: number;
  open_interest: number;
  contract_size: number;
  expiration_date: string;
  expiration_type: string;
  option_type: string;
  root_symbol: string;
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
    updated_at: string;
  };
}

export interface TradierClientOptions {
  apiKey?: string;
  accountId?: string;
  sandbox?: boolean;
}

// ---- Token-bucket rate limiter --------------------------------------------

const BUCKET_CAPACITY = 60; // max burst
const REFILL_RATE = 1; // tokens per second (60/min)

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];

  constructor() {
    this.tokens = BUCKET_CAPACITY;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const newTokens = elapsed * REFILL_RATE;
    this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + newTokens);
    this.lastRefill = now;
  }

  async waitForToken(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private processQueue(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const next = this.queue.shift()!;
      next();
    }
    if (this.queue.length > 0) {
      setTimeout(() => this.processQueue(), 100);
    }
  }
}

// ---- Client ---------------------------------------------------------------

export class TradierClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly accountId: string;
  private readonly bucket: TokenBucket;

  constructor(options: TradierClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TRADIER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Tradier API key is required. Pass apiKey in options or set TRADIER_API_KEY env var.",
      );
    }
    this.apiKey = apiKey;

    this.accountId =
      options.accountId ?? process.env.TRADIER_ACCOUNT ?? "";

    this.baseUrl = options.sandbox
      ? "https://sandbox.tradier.com"
      : "https://api.tradier.com";

    this.bucket = new TokenBucket();
  }

  // -- Internals ------------------------------------------------------------

  private async rateLimitedFetch(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    await this.bucket.waitForToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
    };

    const res = await fetch(url, { ...options, headers });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Tradier API error ${res.status} ${res.statusText}: ${body}`,
      );
    }

    return res;
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | undefined>,
  ): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Batch-fetch quotes for one or more symbols.
   */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    const url = this.buildUrl("/v1/markets/quotes", {
      symbols: symbols.join(","),
    });
    const res = await this.rateLimitedFetch(url);
    const data = await res.json();

    const raw = data?.quotes?.quote;
    if (!raw) return [];

    // Tradier returns a single object when there's only one symbol
    const quotes: unknown[] = Array.isArray(raw) ? raw : [raw];

    return quotes.map((q: any) => ({
      symbol: q.symbol,
      last: q.last ?? 0,
      bid: q.bid ?? 0,
      ask: q.ask ?? 0,
      prevclose: q.prevclose ?? null,
      volume: q.volume ?? 0,
      change: q.change ?? 0,
      change_percentage: q.change_percentage ?? 0,
    }));
  }

  /**
   * Fetch OHLCV history for a symbol.
   */
  async getHistory(
    symbol: string,
    interval?: string,
    start?: string,
    end?: string,
  ): Promise<OHLCVBar[]> {
    const url = this.buildUrl("/v1/markets/history", {
      symbol,
      interval,
      start,
      end,
    });
    const res = await this.rateLimitedFetch(url);
    const data = await res.json();

    const raw = data?.history?.day;
    if (!raw) return [];

    const bars: unknown[] = Array.isArray(raw) ? raw : [raw];

    return bars.map((b: any) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
  }

  /**
   * Get the current market clock (open/closed state, next change, etc.).
   */
  async getMarketClock(): Promise<MarketClock> {
    const url = this.buildUrl("/v1/markets/clock");
    const res = await this.rateLimitedFetch(url);
    const data = await res.json();

    const c = data?.clock;
    return {
      date: c.date,
      description: c.description,
      state: c.state,
      timestamp: c.timestamp,
      next_change: c.next_change,
      next_state: c.next_state,
    };
  }

  /**
   * Get the market calendar for a given month/year.
   */
  async getMarketCalendar(
    month?: number,
    year?: number,
  ): Promise<CalendarDay[]> {
    const url = this.buildUrl("/v1/markets/calendar", {
      month: month?.toString(),
      year: year?.toString(),
    });
    const res = await this.rateLimitedFetch(url);
    const data = await res.json();

    const raw = data?.calendar?.days?.day;
    if (!raw) return [];

    const days: unknown[] = Array.isArray(raw) ? raw : [raw];

    return days.map((d: any) => ({
      date: d.date,
      status: d.status,
      description: d.description,
      premarket: d.premarket ?? { start: "", end: "" },
      open: d.open ?? { start: "", end: "" },
      postmarket: d.postmarket ?? { start: "", end: "" },
    }));
  }

  /**
   * Create a streaming session and return the session ID.
   * Use the session ID to connect to the Tradier WebSocket endpoint.
   */
  async createStreamSession(): Promise<string> {
    const url = this.buildUrl("/v1/markets/events/session");
    const res = await this.rateLimitedFetch(url, { method: "POST" });
    const data = await res.json();

    const sessionId = data?.stream?.sessionid;
    if (!sessionId) {
      throw new Error("Failed to create stream session: no sessionid in response");
    }
    return sessionId;
  }

  /**
   * Fetch the options chain for a symbol at a given expiration.
   */
  async getOptionsChain(
    symbol: string,
    expiration: string,
    greeks?: boolean,
  ): Promise<OptionsChainItem[]> {
    const url = this.buildUrl("/v1/markets/options/chains", {
      symbol,
      expiration,
      greeks: greeks ? "true" : undefined,
    });
    const res = await this.rateLimitedFetch(url);
    const data = await res.json();

    const raw = data?.options?.option;
    if (!raw) return [];

    const items: unknown[] = Array.isArray(raw) ? raw : [raw];

    return items.map((o: any) => ({
      symbol: o.symbol,
      description: o.description,
      exch: o.exch,
      type: o.type,
      last: o.last,
      change: o.change,
      volume: o.volume ?? 0,
      open: o.open,
      high: o.high,
      low: o.low,
      close: o.close,
      bid: o.bid ?? 0,
      ask: o.ask ?? 0,
      underlying: o.underlying,
      strike: o.strike,
      change_percentage: o.change_percentage,
      average_volume: o.average_volume ?? 0,
      last_volume: o.last_volume ?? 0,
      trade_date: o.trade_date ?? 0,
      prevclose: o.prevclose,
      week_52_high: o.week_52_high ?? 0,
      week_52_low: o.week_52_low ?? 0,
      bidsize: o.bidsize ?? 0,
      bidexch: o.bidexch ?? "",
      bid_date: o.bid_date ?? 0,
      asksize: o.asksize ?? 0,
      askexch: o.askexch ?? "",
      ask_date: o.ask_date ?? 0,
      open_interest: o.open_interest ?? 0,
      contract_size: o.contract_size ?? 100,
      expiration_date: o.expiration_date,
      expiration_type: o.expiration_type,
      option_type: o.option_type,
      root_symbol: o.root_symbol,
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
            updated_at: o.greeks.updated_at,
          }
        : undefined,
    }));
  }
}
