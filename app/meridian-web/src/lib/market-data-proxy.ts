/**
 * Market data proxy dispatcher.
 *
 * Routes to synthetic-proxy or tradier-proxy based on the MARKET_DATA_SOURCE
 * env var (evaluated once at module load time). Uses dynamic import() to
 * avoid loading Tradier dependencies in synthetic mode and vice versa.
 */

import type { Quote, OHLCVBar, OptionsChainItem } from "./tradier-proxy";

export type { Quote, OHLCVBar, OptionsChainItem };

const isSynthetic = process.env.MARKET_DATA_SOURCE === "synthetic";

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (isSynthetic) {
    const mod = await import("./synthetic-proxy");
    return mod.getQuotes(symbols);
  }
  const mod = await import("./tradier-proxy");
  return mod.getQuotes(symbols);
}

export async function getHistory(
  symbol: string,
  start?: string,
  end?: string,
): Promise<OHLCVBar[]> {
  if (isSynthetic) {
    const mod = await import("./synthetic-proxy");
    return mod.getHistory(symbol, start, end);
  }
  const mod = await import("./tradier-proxy");
  return mod.getHistory(symbol, start, end);
}

export async function getOptionsChain(
  symbol: string,
  expiration: string,
): Promise<OptionsChainItem[]> {
  if (isSynthetic) {
    const mod = await import("./synthetic-proxy");
    return mod.getOptionsChain(symbol, expiration);
  }
  const mod = await import("./tradier-proxy");
  return mod.getOptionsChain(symbol, expiration);
}

export async function getExpirations(symbol: string): Promise<string[]> {
  if (isSynthetic) {
    const mod = await import("./synthetic-proxy");
    return mod.getExpirations(symbol);
  }
  const mod = await import("./tradier-proxy");
  return mod.getExpirations(symbol);
}

export function getTodayExpiration(): string {
  // Pure date math — same implementation regardless of mode
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
