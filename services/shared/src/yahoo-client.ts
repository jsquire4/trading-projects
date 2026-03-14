// ---------------------------------------------------------------------------
// Yahoo Finance Client — implements IMarketDataClient
//
// Free market data, no API key required. Replaces TradierClient.
// Uses yahoo-finance2 npm package for quotes and OHLCV history.
// Options chain and streaming are not supported (callers removed).
// ---------------------------------------------------------------------------

import YahooFinance from "yahoo-finance2";
import type {
  Quote,
  OHLCVBar,
  MarketClock,
  CalendarDay,
  OptionsChainItem,
  IMarketDataClient,
} from "./market-data";

export class YahooClient implements IMarketDataClient {
  private readonly yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    const results: Quote[] = [];

    for (const symbol of symbols) {
      try {
        const q = await this.yf.quote(symbol);
        if (!q) continue;

        const last = q.regularMarketPrice ?? 0;
        const prevclose = q.regularMarketPreviousClose ?? null;
        const change = q.regularMarketChange ?? 0;
        const changePct = q.regularMarketChangePercent ?? 0;

        results.push({
          symbol: q.symbol ?? symbol,
          last,
          bid: q.bid ?? last,
          ask: q.ask ?? last,
          prevclose,
          volume: q.regularMarketVolume ?? 0,
          change,
          change_percentage: changePct,
        });
      } catch {
        // Skip symbols that fail (delisted, invalid, etc.)
      }
    }

    return results;
  }

  async getHistory(
    symbol: string,
    _interval?: string,
    start?: string,
    end?: string,
  ): Promise<OHLCVBar[]> {
    const period1 = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const period2 = end ? new Date(end) : new Date();

    try {
      const result = await this.yf.chart(symbol, {
        period1,
        period2,
        interval: "1d" as const,
      });

      if (!result?.quotes) return [];

      return result.quotes
        .filter((bar) => bar.close !== null && bar.close !== undefined)
        .map((bar) => ({
          date: new Date(bar.date).toISOString().slice(0, 10),
          open: bar.open ?? 0,
          high: bar.high ?? 0,
          low: bar.low ?? 0,
          close: bar.close ?? 0,
          volume: bar.volume ?? 0,
        }));
    } catch {
      return [];
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    // Derive market state from a quote for a liquid symbol
    try {
      const q = await this.yf.quote("AAPL");
      const state = q?.marketState ?? "CLOSED";

      // Map Yahoo marketState to our format
      const stateMap: Record<string, string> = {
        PRE: "premarket",
        REGULAR: "open",
        POST: "postmarket",
        CLOSED: "closed",
        PREPRE: "premarket",
        POSTPOST: "closed",
      };

      const now = new Date();
      return {
        date: now.toISOString().slice(0, 10),
        description: `Market is ${stateMap[state] ?? state}`,
        state: stateMap[state] ?? "closed",
        timestamp: Math.floor(now.getTime() / 1000),
        next_change: state === "REGULAR" ? "16:00" : "09:30",
        next_state: state === "REGULAR" ? "postmarket" : "open",
      };
    } catch {
      const now = new Date();
      return {
        date: now.toISOString().slice(0, 10),
        description: "Market state unknown",
        state: "closed",
        timestamp: Math.floor(now.getTime() / 1000),
        next_change: "09:30",
        next_state: "open",
      };
    }
  }

  async getMarketCalendar(month?: number, year?: number): Promise<CalendarDay[]> {
    // Yahoo Finance doesn't have a calendar endpoint — return weekdays only
    const now = new Date();
    const m = month ?? (now.getMonth() + 1);
    const y = year ?? now.getFullYear();

    const days: CalendarDay[] = [];
    const daysInMonth = new Date(y, m, 0).getDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      days.push({
        date: date.toISOString().slice(0, 10),
        status: "open",
        description: "Trading day",
        premarket: { start: "07:00", end: "09:30" },
        open: { start: "09:30", end: "16:00" },
        postmarket: { start: "16:00", end: "20:00" },
      });
    }

    return days;
  }

  async createStreamSession(): Promise<string> {
    throw new Error("Streaming is not supported by Yahoo Finance client. Use REST polling instead.");
  }

  async getOptionsChain(
    _symbol: string,
    _expiration: string,
    _greeks?: boolean,
  ): Promise<OptionsChainItem[]> {
    throw new Error("Options chain is not supported by Yahoo Finance client.");
  }
}
