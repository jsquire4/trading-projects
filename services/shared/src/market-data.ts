// ---------------------------------------------------------------------------
// Market Data Client — interface + factory
//
// Abstraction over live (Tradier) and synthetic data sources. Consumers
// import createMarketDataClient() instead of constructing TradierClient
// directly, enabling MARKET_DATA_SOURCE=synthetic mode.
// ---------------------------------------------------------------------------

import type {
  Quote,
  OHLCVBar,
  MarketClock,
  CalendarDay,
  OptionsChainItem,
  TradierClientOptions,
} from "./tradier-client";

import { TradierClient } from "./tradier-client";
import { SyntheticClient } from "./synthetic-client";

export type { Quote, OHLCVBar, MarketClock, CalendarDay, OptionsChainItem, TradierClientOptions };

/** Interface implemented by both TradierClient and SyntheticClient. */
export interface IMarketDataClient {
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getHistory(symbol: string, interval?: string, start?: string, end?: string): Promise<OHLCVBar[]>;
  getMarketClock(): Promise<MarketClock>;
  getMarketCalendar(month?: number, year?: number): Promise<CalendarDay[]>;
  createStreamSession(): Promise<string>;
  getOptionsChain(symbol: string, expiration: string, greeks?: boolean): Promise<OptionsChainItem[]>;
}

/**
 * Factory that returns a TradierClient or SyntheticClient based on
 * the MARKET_DATA_SOURCE env var.
 *
 * - "synthetic" → SyntheticClient (no API key needed)
 * - anything else (including unset) → TradierClient (live mode)
 */
export function createMarketDataClient(options?: TradierClientOptions): IMarketDataClient {
  const source = process.env.MARKET_DATA_SOURCE ?? "live";

  if (source === "synthetic") {
    const rawSeed = parseInt(process.env.SYNTHETIC_SEED ?? "42", 10);
    const seed = Number.isFinite(rawSeed) ? rawSeed : 42;
    return new SyntheticClient({ seed });
  }

  return new TradierClient(options);
}
