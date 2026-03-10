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
      const res = await fetch(`/api/tradier/quotes?symbols=${symbols.join(",")}`);
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
        `/api/tradier/history?symbol=${symbol}&start=${startStr}&end=${endStr}`,
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
 * Fetch options chain for a symbol at today's expiration.
 * Returns empty array if no 0DTE options exist for this ticker.
 */
export function useTradierOptions(symbol: string | null) {
  return useQuery<OptionsChainItem[]>({
    queryKey: ["tradier-options", symbol],
    queryFn: async () => {
      if (!symbol) return [];
      const res = await fetch(`/api/tradier/options?symbol=${symbol}`);
      if (!res.ok) throw new Error(`Options fetch failed: ${res.status}`);
      return res.json();
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
  const { type, market, limit = 100 } = options ?? {};

  return useQuery<IndexedEvent[]>({
    queryKey: ["indexed-events", type, market, limit],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (market) params.set("market", market);
      params.set("limit", String(limit));

      const res = await fetch(`${EVENT_INDEXER_URL}/events?${params}`);
      if (!res.ok) throw new Error(`Event indexer fetch failed: ${res.status}`);
      return res.json();
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
