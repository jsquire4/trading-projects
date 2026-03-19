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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMeridianIndex() {
  return useQuery<MeridianIndexData>({
    queryKey: ["meridian-index"],
    queryFn: () => fetchJson(`${EVENT_INDEXER_URL}/api/index/current`),
    staleTime: 25_000,
    refetchInterval: 30_000,
    retry: 2,
  });
}

export function useIndexHistory(period: "intraday" | "daily" = "intraday", days = 7) {
  return useQuery<{ snapshots: IndexSnapshot[]; period: string; days: number }>({
    queryKey: ["index-history", period, days],
    queryFn: () => fetchJson(`${EVENT_INDEXER_URL}/api/index/history?period=${period}&days=${days}`),
    staleTime: 55_000,
    refetchInterval: 60_000,
    retry: 2,
  });
}

export function useConvictionLeaders(limit = 20) {
  return useQuery<{ leaders: ConvictionLeader[] }>({
    queryKey: ["conviction-leaders", limit],
    queryFn: () => fetchJson(`${EVENT_INDEXER_URL}/api/conviction/leaders?limit=${limit}`),
    staleTime: 55_000,
    refetchInterval: 60_000,
    retry: 2,
  });
}

export function useSmartMoney() {
  return useQuery<{ signals: SmartMoneySignal[] }>({
    queryKey: ["smart-money"],
    queryFn: () => fetchJson(`${EVENT_INDEXER_URL}/api/signals/smart-money`),
    staleTime: 25_000,
    refetchInterval: 30_000,
    retry: 2,
  });
}

export function useWalletConviction(wallet: string | null | undefined) {
  return useQuery<WalletConviction>({
    queryKey: ["wallet-conviction", wallet],
    queryFn: () => fetchJson(`${EVENT_INDEXER_URL}/api/conviction/${wallet}`),
    enabled: !!wallet,
    staleTime: 55_000,
    retry: 2,
  });
}
