"use client";

/**
 * Shared data-fetching hooks for analytics components.
 *
 * All analytics components use these hooks to fetch Tradier and event indexer
 * data. Built on TanStack Query for caching and deduplication.
 */

import { useQuery } from "@tanstack/react-query";
import type { OHLCVBar, Quote, OptionsChainItem } from "@/lib/tradier-proxy";

// ---------------------------------------------------------------------------
// Event indexer types
// ---------------------------------------------------------------------------

export interface IndexedEvent {
  id: number;
  type: string;
  market: string;
  data: string;
  signature: string;
  slot: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tradier data hooks (fetch via /api/tradier/* routes)
// ---------------------------------------------------------------------------

/**
 * Fetch quotes for one or more tickers.
 * Polls every 30s. Data served from server-side 60s TTL cache.
 */
export function useTradierQuotes(symbols: string[]) {
  return useQuery<Quote[]>({
    queryKey: ["tradier-quotes", symbols.sort().join(",")],
    queryFn: async () => {
      if (symbols.length === 0) return [];
      const res = await fetch(`/api/tradier/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      if (!res.ok) throw new Error(`Quotes fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: symbols.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * Fetch OHLCV history for a symbol (default: last 365 days).
 * Cached for 5 minutes — historical data doesn't change intraday.
 */
export function useTradierHistory(symbol: string | null, days: number = 365) {
  return useQuery<OHLCVBar[]>({
    queryKey: ["tradier-history", symbol, days],
    queryFn: async () => {
      if (!symbol) return [];
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - Math.ceil(days * 1.5)); // extra buffer for weekends/holidays
      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];
      const res = await fetch(
        `/api/tradier/history?symbol=${encodeURIComponent(symbol)}&start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`,
      );
      if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: !!symbol,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Options chain result including the expiration date used.
 */
export interface OptionsResult {
  chain: OptionsChainItem[];
  expiration: string | null;
}

/**
 * Fetch available expiration dates for a symbol.
 */
export function useTradierExpirations(symbol: string | null) {
  return useQuery<string[]>({
    queryKey: ["tradier-expirations", symbol],
    queryFn: async () => {
      if (!symbol) return [];
      const res = await fetch(`/api/tradier/expirations?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error(`Expirations fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: !!symbol,
    staleTime: 5 * 60_000,
  });
}

/**
 * Fetch options chain for a symbol.
 * If no expiration specified, tries today (0DTE) first, then falls back to nearest.
 */
export function useTradierOptions(symbol: string | null, expiration?: string | null) {
  return useQuery<OptionsResult>({
    queryKey: ["tradier-options", symbol, expiration ?? "auto"],
    queryFn: async () => {
      if (!symbol) return { chain: [], expiration: null };
      let url = `/api/tradier/options?symbol=${encodeURIComponent(symbol)}`;
      if (expiration) url += `&expiration=${encodeURIComponent(expiration)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Options fetch failed: ${res.status}`);
      const exp = res.headers.get("X-Expiration");
      const chain = await res.json();
      return { chain: Array.isArray(chain) ? chain : [], expiration: exp };
    },
    enabled: !!symbol,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Event indexer hooks
// ---------------------------------------------------------------------------

const EVENT_INDEXER_URL = process.env.NEXT_PUBLIC_EVENT_INDEXER_URL ?? "http://localhost:4800";

/**
 * Fetch events from the event indexer, optionally filtered by type and market.
 */
export function useIndexedEvents(options?: {
  type?: string;
  market?: string;
  limit?: number;
}) {
  const { type, market, limit: rawLimit = 100 } = options ?? {};
  const limit = Math.min(rawLimit, 1000); // Cap at 1000 to prevent excessive fetches (#12)

  return useQuery<IndexedEvent[]>({
    queryKey: ["indexed-events", type, market, limit],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (market) params.set("market", market);
      params.set("limit", String(limit));

      const res = await fetch(`${EVENT_INDEXER_URL}/events?${params}`);
      if (!res.ok) throw new Error(`Event indexer fetch failed: ${res.status}`);
      const json = await res.json();
      // API returns { events: [...], count, limit, offset } — unwrap
      return Array.isArray(json) ? json : (json.events ?? []);
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/**
 * Fetch settlement events only.
 */
export function useSettlementEvents(limit: number = 500) {
  return useIndexedEvents({ type: "settlement", limit });
}

/**
 * Fetch fill events for a specific market.
 */
export function useFillEvents(market: string | null, limit: number = 200) {
  return useIndexedEvents({
    type: "fill",
    market: market ?? undefined,
    limit,
  });
}
