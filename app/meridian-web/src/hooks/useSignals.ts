"use client";

import { useQuery } from "@tanstack/react-query";
import { EVENT_INDEXER_URL } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TickerIndexEntry {
  ticker: string;
  vwap: number;
  volume: number;
  fillCount: number;
}

export interface MeridianIndexData {
  value: number;
  dispersion: number;
  tickers: TickerIndexEntry[];
  timestamp: number;
}

export interface IndexSnapshot {
  id: number;
  timestamp: number;
  value: number;
  dispersion: number;
}

export interface ConvictionLeader {
  wallet: string;
  score: number;
  trades: number;
  winRate: number;
  topTicker: string;
}

export interface SmartMoneySignal {
  ticker: string;
  direction: "yes" | "no";
  strength: number;
  fillCount: number;
  avgConviction: number;
}

export interface WalletConviction {
  wallet: string;
  score: number;
  trades: number;
  winRate: number;
  byTicker: { ticker: string; score: number; trades: number }[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useMeridianIndex() {
  return useQuery<MeridianIndexData>({
    queryKey: ["meridian-index"],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/index/current`);
      if (!res.ok) return { value: 50, dispersion: 0, tickers: [], timestamp: Date.now() / 1000 };
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useIndexHistory(period: "intraday" | "daily" = "intraday", days = 7) {
  return useQuery<{ snapshots: IndexSnapshot[]; period: string; days: number }>({
    queryKey: ["index-history", period, days],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/index/history?period=${period}&days=${days}`);
      if (!res.ok) return { snapshots: [], period, days };
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useConvictionLeaders(limit = 20) {
  return useQuery<{ leaders: ConvictionLeader[] }>({
    queryKey: ["conviction-leaders", limit],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/conviction/leaders?limit=${limit}`);
      if (!res.ok) return { leaders: [] };
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useSmartMoney() {
  return useQuery<{ signals: SmartMoneySignal[] }>({
    queryKey: ["smart-money"],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/signals/smart-money`);
      if (!res.ok) return { signals: [] };
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useWalletConviction(wallet: string | null | undefined) {
  return useQuery<WalletConviction>({
    queryKey: ["wallet-conviction", wallet],
    queryFn: async () => {
      const res = await fetch(`${EVENT_INDEXER_URL}/api/conviction/${wallet}`);
      if (!res.ok) return { wallet: wallet!, score: 0, trades: 0, winRate: 0, byTicker: [] };
      return res.json();
    },
    enabled: !!wallet,
    staleTime: 60_000,
  });
}
