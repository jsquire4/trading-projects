"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions } from "@/hooks/usePositions";
import {
  writeSnapshot,
  consolidateOldSnapshots,
  getIntradaySnapshots,
  getDailySummaries,
  type PnlSnapshot,
  type PositionSnapshot,
  type DailySummary,
} from "@/lib/portfolioDb";

// NOTE: useOrderBook only works for a single market. For portfolio-wide snapshots,
// we'll use position data directly without live mid-price valuation.
// The snapshot stores the token balances and a rough value estimate.

/**
 * Piggybacks on usePositions polling (15s) to write P&L snapshots to IndexedDB.
 * Runs consolidation on mount to compress old intraday data into daily summaries.
 */
export function usePortfolioSnapshot() {
  const { publicKey } = useWallet();
  const { data: positions = [] } = usePositions();
  const [intradayData, setIntradayData] = useState<PnlSnapshot[]>([]);
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);
  const [isReady, setIsReady] = useState(false);
  const lastSnapshotRef = useRef<number>(0);
  const consolidatedRef = useRef(false);

  const wallet = publicKey?.toBase58() ?? "";

  // Consolidate old data on mount (once per session)
  useEffect(() => {
    if (!wallet || consolidatedRef.current) return;
    consolidateOldSnapshots(wallet)
      .then(() => { consolidatedRef.current = true; })
      .catch(() => {});
  }, [wallet]);

  // Write snapshot when positions change (throttled to max once per 10s)
  useEffect(() => {
    if (!wallet || positions.length === 0) return;

    const now = Date.now();
    if (now - lastSnapshotRef.current < 10_000) return;
    lastSnapshotRef.current = now;

    const posSnapshots: PositionSnapshot[] = positions.map((p) => ({
      market: p.market.publicKey.toBase58(),
      ticker: p.market.ticker,
      yesBal: Number(p.yesBal) / 1_000_000,
      noBal: Number(p.noBal) / 1_000_000,
      // Rough valuation: use 50c mid as fallback when no live book data
      yesValue: (Number(p.yesBal) / 1_000_000) * 0.5,
      noValue: (Number(p.noBal) / 1_000_000) * 0.5,
    }));

    const totalValue = posSnapshots.reduce(
      (sum, ps) => sum + ps.yesValue + ps.noValue,
      0,
    );

    const snapshot: PnlSnapshot = {
      ts: now,
      wallet,
      totalValue,
      positions: posSnapshots,
    };

    writeSnapshot(snapshot).catch(() => {});
  }, [wallet, positions]);

  // Load intraday data and daily summaries (clear on wallet disconnect)
  useEffect(() => {
    if (!wallet) {
      setIntradayData([]);
      setDailySummaries([]);
      setIsReady(false);
      return;
    }

    async function load() {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const [intraday, summaries] = await Promise.all([
        getIntradaySnapshots(wallet, today.getTime()),
        getDailySummaries(wallet),
      ]);
      setIntradayData(intraday);
      setDailySummaries(summaries);
      setIsReady(true);
    }

    load();
    // Refresh every 30s
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [wallet]);

  // Compute current total P&L from today's data
  const todayPnl =
    intradayData.length >= 2
      ? intradayData[intradayData.length - 1].totalValue -
        intradayData[0].totalValue
      : 0;

  const currentValue =
    intradayData.length > 0
      ? intradayData[intradayData.length - 1].totalValue
      : 0;

  // Find top and bottom performers from latest snapshot
  const latestSnapshot =
    intradayData.length > 0 ? intradayData[intradayData.length - 1] : null;

  const firstSnapshot = intradayData.length > 0 ? intradayData[0] : null;

  let topPerformer: { ticker: string; pnl: number } | null = null;
  let bottomPerformer: { ticker: string; pnl: number } | null = null;

  if (latestSnapshot && firstSnapshot) {
    const pnlByTicker = new Map<string, number>();
    for (const pos of latestSnapshot.positions) {
      const latestVal = pos.yesValue + pos.noValue;
      const firstPos = firstSnapshot.positions.find(
        (p) => p.market === pos.market,
      );
      const firstVal = firstPos ? firstPos.yesValue + firstPos.noValue : 0;
      const existing = pnlByTicker.get(pos.ticker) ?? 0;
      pnlByTicker.set(pos.ticker, existing + (latestVal - firstVal));
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
  };
}
