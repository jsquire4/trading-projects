/**
 * Shared ticker universe for Meridian.
 * Single source of truth — import from here, never duplicate.
 */

export const MAG7 = ["AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "META", "TSLA"] as const;

export const LARGE_CAP = [
  "JPM", "V", "UNH", "XOM", "JNJ", "WMT", "MA", "PG",
  "HD", "COST", "ABBV", "LLY", "AVGO", "MRK", "KO", "PEP", "CVX", "CRM",
] as const;

export const INDEX_ETFS = ["SPY", "QQQ"] as const;
export const VOLATILITY = ["VXX", "UVXY"] as const;
export const PRECIOUS_METALS = ["GLD", "SLV"] as const;

export const OTHER_ASSETS = [...LARGE_CAP, ...INDEX_ETFS, ...VOLATILITY, ...PRECIOUS_METALS] as const;

export const FULL_UNIVERSE = [...MAG7, ...OTHER_ASSETS] as const;

export type Ticker = (typeof FULL_UNIVERSE)[number];
