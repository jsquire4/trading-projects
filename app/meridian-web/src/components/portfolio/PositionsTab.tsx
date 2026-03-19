"use client";

import Link from "next/link";
import { useMemo, useState, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions, type Position } from "@/hooks/usePositions";
import { useOrderBooks, type OrderBookData } from "@/hooks/useMarkets";
import { useCostBasis } from "@/hooks/useCostBasis";
import { useRedeem } from "@/hooks/useRedeem";
import { InsightTooltip } from "@/components/InsightTooltip";
import { interpretPosition } from "@/lib/insights";
import { calcPositionValue } from "@/lib/positions";

// ---------------------------------------------------------------------------
// Compact Position Card — 1/3 width, colored glow
// ---------------------------------------------------------------------------

function PositionCard({ position, totalCost, avgPriceCents, now, book }: {
  position: Position; totalCost: number; avgPriceCents: number | null;
  now: number; book: OrderBookData | undefined;
}) {
  const { publicKey } = useWallet();
  const { redeem, submitting } = useRedeem();

  const yesBal = Number(position.yesBal) / 1_000_000;
  const noBal = Number(position.noBal) / 1_000_000;
  const strikeDollars = Number(position.market.strikePrice) / 1_000_000;
  const closeUnix = Number(position.market.marketCloseUnix);
  const remaining = Math.max(0, closeUnix - now);

  const midPrice = useMemo(() => {
    if (!book?.yesView.bestBid || !book?.yesView.bestAsk) return null;
    return (book.yesView.bestBid + book.yesView.bestAsk) / 2;
  }, [book]);

  const totalValue = midPrice !== null ? calcPositionValue(yesBal, noBal, midPrice / 100) : null;

  const isSettled = position.market.isSettled;
  const outcome = position.market.outcome;
  const isYesWinner = outcome === 1;
  const isWinner = (outcome === 1 && yesBal > 0) || (outcome === 2 && noBal > 0);
  const winnerBal = isYesWinner ? position.yesBal : position.noBal;
  const winnerTokens = Number(winnerBal) / 1_000_000;
  const winnerLabel = isYesWinner ? "Yes" : "No";

  const overrideDeadline = Number(position.market.overrideDeadline);
  const inOverrideWindow = isSettled && now < overrideDeadline;
  const canRedeem = isSettled && isWinner && !inOverrideWindow && winnerBal > BigInt(0);

  const hedgedPairs = Math.min(yesBal, noBal);
  const canPairBurn = hedgedPairs > 0; // pair-burn is valid even after settlement

  const minutesLeft = Math.max(0, remaining / 60);
  const side = yesBal >= noBal ? "yes" : "no";
  const pnl = totalValue !== null ? totalValue - totalCost : null;
  const positionInsight = pnl !== null ? interpretPosition(side, pnl, minutesLeft) : null;

  const settledValue = isSettled ? (isWinner ? winnerTokens : 0) : null;
  const displayValue = settledValue !== null ? settledValue : totalValue;
  const pnlDisplay = displayValue !== null && totalCost > 0 ? displayValue - totalCost : null;
  const pnlPositive = pnlDisplay !== null && pnlDisplay >= 0;

  const holdingSide = yesBal > 0 && noBal > 0 ? "Both" : yesBal > 0 ? "Yes" : "No";
  const holdingQty = yesBal > 0 && noBal > 0 ? `${yesBal.toFixed(0)}Y/${noBal.toFixed(0)}N` : (yesBal > 0 ? yesBal : noBal).toFixed(0);

  const formatCountdown = (secs: number) => {
    if (secs <= 0) return "Closed";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const handleRedeem = useCallback(async () => {
    if (!publicKey || winnerBal <= BigInt(0)) return;
    await redeem({ mode: 1, amount: winnerBal, marketPublicKey: position.market.publicKey, description: `Redeem ${winnerTokens.toFixed(0)} ${winnerLabel} tokens` });
  }, [publicKey, position.market.publicKey, winnerBal, winnerTokens, winnerLabel, redeem]);

  const handlePairBurn = useCallback(async () => {
    if (!publicKey || hedgedPairs <= 0) return;
    await redeem({ mode: 0, amount: BigInt(Math.floor(hedgedPairs * 1_000_000)), marketPublicKey: position.market.publicKey, description: `Cash out ${hedgedPairs.toFixed(0)} pairs` });
  }, [publicKey, hedgedPairs, position.market.publicKey, redeem]);

  // Glow color based on state
  const glowShadow = isSettled
    ? isWinner
      ? "shadow-[0_4px_20px_rgba(34,197,94,0.12),0_0_40px_rgba(34,197,94,0.06)]"
      : "shadow-[0_4px_20px_rgba(239,68,68,0.1),0_0_40px_rgba(239,68,68,0.04)]"
    : holdingSide === "Yes"
      ? "shadow-[0_4px_20px_rgba(34,197,94,0.08),0_0_30px_rgba(34,197,94,0.04)]"
      : holdingSide === "No"
        ? "shadow-[0_4px_20px_rgba(239,68,68,0.08),0_0_30px_rgba(239,68,68,0.04)]"
        : "shadow-[0_4px_20px_rgba(59,130,246,0.08),0_0_30px_rgba(59,130,246,0.04)]";

  const borderColor = isSettled
    ? isWinner ? "border-green-500/25" : "border-red-500/20"
    : holdingSide === "Yes" ? "border-green-500/15" : holdingSide === "No" ? "border-red-500/15" : "border-blue-500/15";

  return (
    <div className={`group relative overflow-hidden rounded-xl border ${borderColor} ${glowShadow} transition-all duration-300 hover:scale-[1.02]`}>
      {/* Gradient bg */}
      <div className={`absolute inset-0 bg-gradient-to-br ${
        isSettled && isWinner ? "from-green-500/[0.06] to-transparent"
          : isSettled ? "from-red-500/[0.04] to-transparent"
          : "from-white/[0.03] to-transparent"
      }`} />
      {/* Shimmer */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />

      <div className="relative px-4 py-3.5">
        {/* Header: ticker + strike + badge */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            {positionInsight ? (
              <InsightTooltip insight={positionInsight}>
                <Link href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`} className="text-base font-bold text-white hover:text-accent transition-colors">
                  {position.market.ticker}
                </Link>
              </InsightTooltip>
            ) : (
              <Link href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`} className="text-base font-bold text-white hover:text-accent transition-colors">
                {position.market.ticker}
              </Link>
            )}
            <span className="text-white/25 font-mono text-xs">${strikeDollars.toFixed(0)}</span>
          </div>
          {isSettled ? (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              isWinner ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
            }`}>
              {isWinner ? "WON" : "LOST"}
            </span>
          ) : (
            <span className="text-[10px] text-white/25 font-mono tabular-nums">{formatCountdown(remaining)}</span>
          )}
        </div>

        {/* Stats: 2×2 compact grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
          <div>
            <div className="text-[9px] text-white/25 uppercase tracking-wider">Side</div>
            <div className="flex items-center gap-1">
              <span className={`text-[10px] font-bold px-1 py-px rounded ${
                holdingSide === "Yes" ? "bg-green-500/15 text-green-400"
                  : holdingSide === "No" ? "bg-red-500/15 text-red-400"
                  : "bg-blue-500/15 text-blue-400"
              }`}>{holdingSide}</span>
              <span className="text-xs font-mono text-white/60 tabular-nums">{holdingQty}</span>
            </div>
          </div>
          <div>
            <div className="text-[9px] text-white/25 uppercase tracking-wider">{isSettled ? "Payout" : "Value"}</div>
            <span className="text-xs font-mono font-medium text-white tabular-nums">
              {displayValue !== null ? `$${displayValue.toFixed(2)}` : "—"}
            </span>
          </div>
          {avgPriceCents !== null && (
            <div>
              <div className="text-[9px] text-white/25 uppercase tracking-wider">Entry</div>
              <span className="text-xs font-mono text-white/60 tabular-nums">{avgPriceCents.toFixed(1)}¢</span>
            </div>
          )}
          {pnlDisplay !== null && (
            <div>
              <div className="text-[9px] text-white/25 uppercase tracking-wider">P&L</div>
              <span className={`text-xs font-mono font-bold tabular-nums ${pnlPositive ? "text-green-400" : "text-red-400"}`}>
                {pnlPositive ? "+" : ""}{pnlDisplay.toFixed(2)}
              </span>
            </div>
          )}
        </div>

        {/* Action */}
        {canRedeem ? (
          <button
            onClick={handleRedeem}
            disabled={submitting}
            className="w-full rounded-lg py-1.5 text-[11px] font-semibold text-green-400 bg-green-500/15 border border-green-500/20 hover:bg-green-500/25 disabled:opacity-40 transition-all"
          >
            {submitting ? "..." : `Redeem $${winnerTokens.toFixed(2)}`}
          </button>
        ) : canPairBurn ? (
          <button
            onClick={handlePairBurn}
            disabled={submitting}
            className="w-full rounded-lg py-1.5 text-[11px] font-semibold text-blue-400 bg-blue-500/15 border border-blue-500/20 hover:bg-blue-500/25 disabled:opacity-40 transition-all"
          >
            {submitting ? "..." : `Cash Out $${hedgedPairs.toFixed(2)}`}
          </button>
        ) : isSettled && isWinner && inOverrideWindow ? (
          <div className="text-[10px] text-amber-400/50 text-center font-mono">
            Unlocks {new Date(overrideDeadline * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        ) : isSettled && !isWinner ? (
          <div className="text-[10px] text-white/15 text-center">Expired worthless</div>
        ) : (
          <Link
            href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`}
            className="block w-full text-center rounded-lg py-1.5 text-[11px] font-medium text-accent bg-accent/10 border border-accent/15 hover:bg-accent/20 transition-all"
          >
            Trade →
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PositionsTab — 3-column grid
// ---------------------------------------------------------------------------

export function PositionsTab() {
  const { data: positions = [], isLoading } = usePositions();
  const { costBasis } = useCostBasis();

  const marketKeys = useMemo(() => positions.map((p) => p.market.publicKey), [positions]);
  const { data: orderBooks } = useOrderBooks(marketKeys);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  const sortedPositions = useMemo(() => {
    return [...positions].sort((a, b) => {
      const aWinner = a.market.isSettled && ((a.market.outcome === 1 && a.yesBal > BigInt(0)) || (a.market.outcome === 2 && a.noBal > BigInt(0)));
      const bWinner = b.market.isSettled && ((b.market.outcome === 1 && b.yesBal > BigInt(0)) || (b.market.outcome === 2 && b.noBal > BigInt(0)));
      if (aWinner && !bWinner) return -1;
      if (!aWinner && bWinner) return 1;
      const aSettled = a.market.isSettled ? 1 : 0;
      const bSettled = b.market.isSettled ? 1 : 0;
      if (!aSettled && bSettled) return -1;
      if (aSettled && !bSettled) return 1;
      return 0;
    });
  }, [positions]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-36 rounded-xl bg-white/[0.03] border border-white/[0.06] animate-pulse" />
        ))}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-6 py-12 text-center">
        <p className="text-white/50 text-sm mb-1">No positions yet</p>
        <p className="text-white/25 text-xs mb-4">Place trades to see your active positions here.</p>
        <Link href="/trade" className="text-sm text-accent hover:text-accent/80 transition-colors">
          Browse Markets →
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {sortedPositions.map((pos) => {
        const cb = costBasis.get(pos.market.publicKey.toBase58());
        return (
          <PositionCard
            key={pos.market.publicKey.toBase58()}
            position={pos}
            totalCost={cb?.totalCostUsdc ?? 0}
            avgPriceCents={cb?.avgPrice ?? null}
            now={now}
            book={orderBooks?.get(pos.market.publicKey.toBase58())}
          />
        );
      })}
    </div>
  );
}
