"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePositions, type Position } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { useCostBasis } from "@/hooks/useCostBasis";
import { InsightTooltip } from "@/components/InsightTooltip";
import { interpretPosition } from "@/lib/insights";

function PositionCard({ position, totalCost }: { position: Position; totalCost: number }) {
  const { data: book } = useOrderBook(position.market.publicKey.toBase58());
  const yesBal = Number(position.yesBal) / 1_000_000;
  const noBal = Number(position.noBal) / 1_000_000;
  const strikeDollars = Number(position.market.strikePrice) / 1_000_000;
  const closeUnix = Number(position.market.marketCloseUnix);
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, closeUnix - now);

  const midPrice = useMemo(() => {
    if (!book?.yesView.bestBid || !book?.yesView.bestAsk) return null;
    return (book.yesView.bestBid + book.yesView.bestAsk) / 2;
  }, [book]);

  const yesValue = midPrice ? (yesBal * midPrice) / 100 : null;
  const noValue = midPrice ? (noBal * (100 - midPrice)) / 100 : null;
  const totalValue = (yesValue ?? 0) + (noValue ?? 0);

  const formatCountdown = (secs: number) => {
    if (secs <= 0) return "Expired";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const isSettled = position.market.isSettled;
  const outcome = position.market.outcome;
  const isWinner =
    (outcome === 1 && yesBal > 0) || (outcome === 2 && noBal > 0);

  const minutesLeft = Math.max(0, remaining / 60);
  const side = yesBal >= noBal ? "yes" : "no";
  const pnl = totalValue - totalCost;
  const positionInsight = interpretPosition(side, pnl, minutesLeft);

  return (
    <div className={`rounded-lg border p-4 ${
      isSettled
        ? isWinner
          ? "border-green-500/30 bg-green-500/5"
          : "border-red-500/30 bg-red-500/5"
        : "border-white/10 bg-white/5"
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <InsightTooltip insight={positionInsight}>
            <span className="text-white font-bold">{position.market.ticker}</span>
          </InsightTooltip>
          <span className="text-white/40 font-mono text-sm">${strikeDollars.toFixed(0)}</span>
          {isSettled && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              isWinner ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
            }`}>
              {isWinner ? "WON" : "LOST"}
            </span>
          )}
        </div>
        {!isSettled && (
          <span className="text-xs text-white/40">{formatCountdown(remaining)}</span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
        {yesBal > 0 && (
          <div>
            <span className="text-white/40">Yes</span>
            <div className="text-green-400 font-medium tabular-nums">{yesBal.toFixed(0)}</div>
          </div>
        )}
        {noBal > 0 && (
          <div>
            <span className="text-white/40">No</span>
            <div className="text-red-400 font-medium tabular-nums">{noBal.toFixed(0)}</div>
          </div>
        )}
        {totalValue > 0 && (
          <div>
            <span className="text-white/40">Est. Value</span>
            <div className="text-white font-medium tabular-nums">${totalValue.toFixed(2)}</div>
          </div>
        )}
        {midPrice && (
          <div>
            <span className="text-white/40">Mid Price</span>
            <div className="text-white/70 font-mono">{midPrice.toFixed(0)}c</div>
          </div>
        )}
      </div>

      <Link
        href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`}
        className="text-xs text-accent hover:text-accent/80 transition-colors font-medium"
      >
        {isSettled ? "View Settlement" : "Trade More"} →
      </Link>
    </div>
  );
}

export function PositionsTab() {
  const { data: positions = [], isLoading } = usePositions();
  const { costBasis } = useCostBasis();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-lg bg-white/5 border border-white/10 animate-pulse" />
        ))}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
        <p className="text-white/50 text-sm mb-1">No positions yet</p>
        <p className="text-white/30 text-xs mb-4">
          Place trades to see your active positions here.
        </p>
        <Link
          href="/trade"
          className="text-sm text-accent hover:text-accent/80 transition-colors"
        >
          Browse Markets →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {positions.map((pos) => {
        const cb = costBasis.get(pos.market.publicKey.toBase58());
        return (
          <PositionCard
            key={pos.market.publicKey.toBase58()}
            position={pos}
            totalCost={cb?.totalCostUsdc ?? 0}
          />
        );
      })}
    </div>
  );
}
