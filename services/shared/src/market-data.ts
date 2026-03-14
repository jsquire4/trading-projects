// ---------------------------------------------------------------------------
// Market Data Client — interface, types, and factory
//
// Abstraction over Yahoo Finance and synthetic data sources. Consumers
// import createMarketDataClient() instead of constructing clients directly,
// enabling MARKET_DATA_SOURCE=synthetic mode.
// ---------------------------------------------------------------------------

import { YahooClient } from "./yahoo-client";
import { SyntheticClient } from "./synthetic-client";

// ---- Public interfaces (canonical location for all market data types) ------

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

/** Interface implemented by both YahooClient and SyntheticClient. */
export interface IMarketDataClient {
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getHistory(symbol: string, interval?: string, start?: string, end?: string): Promise<OHLCVBar[]>;
  getMarketClock(): Promise<MarketClock>;
  getMarketCalendar(month?: number, year?: number): Promise<CalendarDay[]>;
  createStreamSession(): Promise<string>;
  getOptionsChain(symbol: string, expiration: string, greeks?: boolean): Promise<OptionsChainItem[]>;
}

/**
 * Factory that returns a YahooClient or SyntheticClient based on
 * the MARKET_DATA_SOURCE env var.
 *
 * - "synthetic" → SyntheticClient (no API key needed)
 * - anything else (including unset) → YahooClient (free, no API key)
 */
export function createMarketDataClient(): IMarketDataClient {
  const source = process.env.MARKET_DATA_SOURCE ?? "live";

  if (source === "synthetic") {
    const rawSeed = parseInt(process.env.SYNTHETIC_SEED ?? "42", 10);
    const seed = Number.isFinite(rawSeed) ? rawSeed : 42;
    return new SyntheticClient({ seed });
  }

  return new YahooClient();
}
