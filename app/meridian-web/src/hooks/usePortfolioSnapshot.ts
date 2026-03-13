"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions } from "@/hooks/usePositions";
import type {
  PnlSnapshot,
  DailySummary,
} from "@/lib/portfolioDb";

// Re-export types for consumers
export type { PnlSnapshot, DailySummary };

const EVENT_INDEXER_URL = process.env.NEXT_PUBLIC_EVENT_INDEXER_URL ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// API response types (from event-indexer)
// ---------------------------------------------------------------------------

interface PortfolioPosition {
  market: string;
  side: number;
  totalQuantity: number;
  totalCost: number;
  avgPrice: number;
  fillCount: number;
}

interface ApiDailySummary {
  date: string;
  totalVolume: number;
  fillCount: number;
  netCostBasis: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches portfolio P&L data from the event-indexer API.
 *
 * Returns the same shape as the old IndexedDB-based implementation so
 * downstream components (PnlTab, etc.) don't need changes.
 *
 * Falls back to a graceful "unavailable" state if the event-indexer is
 * unreachable (no crash, just empty data).
 */
export function usePortfolioSnapshot(midPrices?: Map<string, number>) {
  const { publicKey } = useWallet();
  const { data: positions = [] } = usePositions();
  const [apiPositions, setApiPositions] = useState<PortfolioPosition[]>([]);
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [approximate, setApproximate] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const wallet = publicKey?.toBase58() ?? "";

  // Stable string key for midPrices Map — avoids JSON.stringify on every render
  const midPricesKey = useMemo(
    () => midPrices ? [...midPrices.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(",") : "",
    [midPrices],
  );

  // Fetch portfolio snapshot and history from event-indexer
  useEffect(() => {
    if (!wallet) {
      setApiPositions([]);
      setDailySummaries([]);
      setIsReady(false);
      setUnavailable(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [snapshotRes, historyRes] = await Promise.all([
          fetch(`${EVENT_INDEXER_URL}/api/portfolio/snapshot?wallet=${encodeURIComponent(wallet)}`),
          fetch(`${EVENT_INDEXER_URL}/api/portfolio/history?wallet=${encodeURIComponent(wallet)}&days=30`),
        ]);

        if (cancelled) return;

        if (!snapshotRes.ok || !historyRes.ok) {
          setUnavailable(true);
          setIsReady(true);
          return;
        }

        const snapshotJson = await snapshotRes.json();
        const historyJson = await historyRes.json();

        if (cancelled) return;

        setApiPositions(snapshotJson.positions ?? []);

        // Map API daily summaries to the DailySummary shape consumers expect
        const mappedSummaries: DailySummary[] = (historyJson.dailySummaries ?? []).map((d: ApiDailySummary) => ({
          date: d.date,
          wallet,
          openValue: 0,     // API provides volume-based data, not value snapshots
          closeValue: 0,
          highValue: 0,
          lowValue: 0,
          pnl: d.netCostBasis / (1_000_000 * 100), // micro-tokens * cents → USDC
          positionCount: d.fillCount,
        }));

        setDailySummaries(mappedSummaries);
        setUnavailable(false);
        setIsReady(true);
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setIsReady(true);
        }
      }
    }

    load();
    // Refresh every 30s
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [wallet]);

  // Compute current portfolio value from on-chain positions + mid prices
  const liveValue = useMemo(() => {
    let usedFallback = false;
    const value = positions.reduce((sum, p) => {
      const marketKey = p.market.publicKey.toBase58();
      let yesMid: number;
      let noMid: number;
      if (p.market.isSettled) {
        yesMid = p.market.outcome === 1 ? 1.0 : 0.0;
        noMid = 1 - yesMid;
      } else {
        const mid = midPrices?.get(marketKey);
        yesMid = mid ?? 0.5;
        noMid = 1 - yesMid;
        if (mid === undefined) usedFallback = true;
      }
      return sum + (Number(p.yesBal) / 1_000_000) * yesMid + (Number(p.noBal) / 1_000_000) * noMid;
    }, 0);
    setApproximate(usedFallback);
    return value;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, midPricesKey]);

  // Build intraday-like data from API positions for chart compatibility.
  // The event-indexer provides aggregate fill data, not time-series snapshots,
  // so we synthesize a single "now" snapshot from on-chain positions.
  const intradayData: PnlSnapshot[] = useMemo(() => {
    if (positions.length === 0) return [];
    const posSnapshots = positions.map((p) => {
      const marketKey = p.market.publicKey.toBase58();
      let yesMid: number;
      let noMid: number;
      if (p.market.isSettled) {
        yesMid = p.market.outcome === 1 ? 1.0 : 0.0;
        noMid = 1 - yesMid;
      } else {
        yesMid = midPrices?.get(marketKey) ?? 0.5;
        noMid = 1 - yesMid;
      }
      return {
        market: marketKey,
        ticker: p.market.ticker,
        yesBal: Number(p.yesBal) / 1_000_000,
        noBal: Number(p.noBal) / 1_000_000,
        yesValue: (Number(p.yesBal) / 1_000_000) * yesMid,
        noValue: (Number(p.noBal) / 1_000_000) * noMid,
      };
    });
    return [{
      ts: Date.now(),
      wallet,
      totalValue: liveValue,
      positions: posSnapshots,
    }];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, midPricesKey, liveValue, wallet]);

  // With API-based data, today's P&L isn't time-series based anymore.
  // We use liveValue as the current value; todayPnl is 0 unless we have
  // cost basis from the API positions to compare against.
  const totalCostFromApi = useMemo(() => {
    return apiPositions.reduce((sum, p) => {
      // totalCost is quantity * price (in micro-tokens * cents)
      return sum + p.totalCost / (1_000_000 * 100);
    }, 0);
  }, [apiPositions]);

  const todayPnl = apiPositions.length > 0 ? liveValue - totalCostFromApi : 0;
  const currentValue = liveValue;

  // Find top and bottom performers from current positions
  let topPerformer: { ticker: string; pnl: number } | null = null;
  let bottomPerformer: { ticker: string; pnl: number } | null = null;

  if (positions.length > 0 && apiPositions.length > 0) {
    // Build cost basis map from API
    const costByMarket = new Map<string, number>();
    for (const ap of apiPositions) {
      const existing = costByMarket.get(ap.market) ?? 0;
      costByMarket.set(ap.market, existing + ap.totalCost / (1_000_000 * 100));
    }

    const pnlByTicker = new Map<string, number>();
    for (const pos of positions) {
      const marketKey = pos.market.publicKey.toBase58();
      let yesMid: number;
      let noMid: number;
      if (pos.market.isSettled) {
        yesMid = pos.market.outcome === 1 ? 1.0 : 0.0;
        noMid = 1 - yesMid;
      } else {
        yesMid = midPrices?.get(marketKey) ?? 0.5;
        noMid = 1 - yesMid;
      }
      const currentVal = (Number(pos.yesBal) / 1_000_000) * yesMid + (Number(pos.noBal) / 1_000_000) * noMid;
      const cost = costByMarket.get(marketKey) ?? 0;
      const pnl = currentVal - cost;

      const existing = pnlByTicker.get(pos.market.ticker) ?? 0;
      pnlByTicker.set(pos.market.ticker, existing + pnl);
    }

    for (const [ticker, pnl] of pnlByTicker) {
      if (!topPerformer || pnl > topPerformer.pnl)
        topPerformer = { ticker, pnl };
      if (!bottomPerformer || pnl < bottomPerformer.pnl)
        bottomPerformer = { ticker, pnl };
    }
  }

  return {
    intradayData,
    dailySummaries,
    todayPnl,
    currentValue,
    topPerformer,
    bottomPerformer,
    isReady,
    approximate,
    unavailable,
  };
}
