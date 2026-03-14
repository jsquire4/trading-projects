/**
 * Server-side synthetic market data proxy.
 *
 * Drop-in replacement for yahoo-proxy.ts that uses SyntheticClient
 * from shared. No external API calls, no rate limiting needed.
 */

import { SyntheticClient } from "@shared/synthetic-client";
import type { Quote, OHLCVBar } from "./yahoo-proxy";

// Module-level singleton — survives across requests within the same process
const client = new SyntheticClient({
  seed: parseInt(process.env.SYNTHETIC_SEED ?? "42", 10),
});

export type { Quote, OHLCVBar };

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];

  const raw = await client.getQuotes(symbols);
  return raw.map((q) => ({
    symbol: q.symbol,
    last: q.last,
    bid: q.bid,
    ask: q.ask,
    prevclose: q.prevclose ?? 0,
    volume: q.volume,
    change: q.change,
    change_percentage: q.change_percentage,
  }));
}

export async function getHistory(
  symbol: string,
  start?: string,
  end?: string,
): Promise<OHLCVBar[]> {
  return client.getHistory(symbol, "daily", start, end);
}

// Re-export getTodayExpiration — it's pure date math, same for both modes
export { getTodayExpiration } from "./yahoo-proxy";
