/**
 * Server-side synthetic market data proxy.
 *
 * Drop-in replacement for tradier-proxy.ts that uses SyntheticClient
 * from shared. No external API calls, no rate limiting needed.
 */

import { SyntheticClient } from "@shared/synthetic-client";
import type { Quote, OHLCVBar, OptionsChainItem } from "./tradier-proxy";

// Module-level singleton — survives across requests within the same process
const client = new SyntheticClient({
  seed: parseInt(process.env.SYNTHETIC_SEED ?? "42", 10),
});

export type { Quote, OHLCVBar, OptionsChainItem };

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

export async function getOptionsChain(
  symbol: string,
  expiration: string,
): Promise<OptionsChainItem[]> {
  const raw = await client.getOptionsChain(symbol, expiration, true);
  return raw.map((o) => ({
    symbol: o.symbol,
    description: o.description,
    type: o.type,
    last: o.last,
    bid: o.bid,
    ask: o.ask,
    strike: o.strike,
    option_type: o.option_type,
    expiration_date: o.expiration_date,
    open_interest: o.open_interest,
    volume: o.volume,
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
}

/**
 * Generate synthetic expiration dates.
 * Returns weekly Fridays for the next 8 weeks.
 */
export async function getExpirations(symbol: string): Promise<string[]> {
  // Find next Friday from today
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;

  const expirations: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + daysUntilFriday + i * 7);
    expirations.push(d.toISOString().slice(0, 10));
  }

  return expirations;
}

// Re-export getTodayExpiration — it's pure date math, same for both modes
export { getTodayExpiration } from "./tradier-proxy";
