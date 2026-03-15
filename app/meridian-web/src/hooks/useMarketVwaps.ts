"use client";

import { useQuery } from "@tanstack/react-query";
import { EVENT_INDEXER_URL } from "@/lib/constants";

/**
 * Fetches volume-weighted average fill prices per market from the event
 * indexer. Used by SettlementAnalytics for calibration chart bucketing.
 */
export function useMarketVwaps() {
  return useQuery<Map<string, number>>({
    queryKey: ["market-vwaps"],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/events/market-vwaps`);
      if (!res.ok) return new Map();
      const json = await res.json();
      const map = new Map<string, number>();
      for (const v of json.vwaps ?? []) {
        map.set(v.market, v.vwap); // vwap in cents
      }
      return map;
    },
    staleTime: 60_000,
  });
}
