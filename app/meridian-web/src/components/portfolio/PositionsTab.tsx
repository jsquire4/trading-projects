"use client";

import Link from "next/link";
import { useMemo, useState, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions, type Position } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { useCostBasis } from "@/hooks/useCostBasis";
import { useRedeem } from "@/hooks/useRedeem";
import { InsightTooltip } from "@/components/InsightTooltip";
import { interpretPosition } from "@/lib/insights";
import { calcPositionValue } from "@/lib/positions";

function PositionCard({ position, totalCost, now }: { position: Position; totalCost: number; now: number }) {
  const { data: book } = useOrderBook(position.market.publicKey.toBase58());
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

  // midPrice is in cents (0-100); calcPositionValue expects 0-1 scale
  const totalValue = midPrice !== null ? calcPositionValue(yesBal, noBal, midPrice / 100) : null;

  const formatCountdown = (secs: number) => {
    if (secs <= 0) return "Expired";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const isSettled = position.market.isSettled;
  const outcome = position.market.outcome;
  const isYesWinner = outcome === 1;
  const isWinner =
    (outcome === 1 && yesBal > 0) || (outcome === 2 && noBal > 0);

  const winnerBal = isYesWinner ? position.yesBal : position.noBal;
  const winnerTokens = Number(winnerBal) / 1_000_000;
  const winnerLabel = isYesWinner ? "Yes" : "No";

  const overrideDeadline = Number(position.market.overrideDeadline);
  const inOverrideWindow = isSettled && now < overrideDeadline;
  const canRedeem = isSettled && isWinner && !inOverrideWindow && winnerBal > BigInt(0);

  const minutesLeft = Math.max(0, remaining / 60);
  const side = yesBal >= noBal ? "yes" : "no";
  const pnl = totalValue !== null ? totalValue - totalCost : null;
  const positionInsight = pnl !== null ? interpretPosition(side, pnl, minutesLeft) : null;

  const handleRedeem = useCallback(async () => {
    if (!publicKey || winnerBal <= BigInt(0)) return;
    await redeem({
      mode: 1,
      amount: winnerBal,
      marketPublicKey: position.market.publicKey,
      description: `Redeem ${winnerTokens.toFixed(0)} ${winnerLabel} tokens`,
    });
  }, [publicKey, position.market.publicKey, winnerBal, winnerTokens, winnerLabel, redeem]);

  // Settled value: winners get $1 per token
  const settledValue = isSettled
    ? isWinner ? winnerTokens : 0
    : null;

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
          {positionInsight ? (
            <InsightTooltip insight={positionInsight}>
              <span className="text-white font-bold">{position.market.ticker}</span>
            </InsightTooltip>
          ) : (
            <span className="text-white font-bold">{position.market.ticker}</span>
          )}
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
        <div>
          <span className="text-white/40">{isSettled ? "Value" : "Est. Value"}</span>
          <div className="text-white font-medium tabular-nums">
            {settledValue !== null
              ? `$${settledValue.toFixed(2)}`
              : totalValue !== null
              ? `$${totalValue.toFixed(2)}`
              : "—"}
          </div>
        </div>
        {!isSettled && midPrice && (
          <div>
            <span className="text-white/40">Mid Price</span>
            <div className="text-white/70 font-mono">{midPrice.toFixed(0)}c</div>
          </div>
        )}
      </div>

      {/* Redeem button for winning settled positions */}
      {canRedeem ? (
        <button
          onClick={handleRedeem}
          disabled={submitting}
          className="w-full rounded-md py-2 text-xs font-semibold text-white bg-green-500/20 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
        >
          {submitting ? "Redeeming..." : `Redeem $${winnerTokens.toFixed(2)} USDC`}
        </button>
      ) : isSettled && isWinner && inOverrideWindow ? (
        <p className="text-[11px] text-yellow-400/60">
          Redemption unlocks at {new Date(overrideDeadline * 1000).toLocaleTimeString()}
        </p>
      ) : isSettled && !isWinner ? (
        <p className="text-[11px] text-white/30">
          Position expired worthless
        </p>
      ) : (
        <Link
          href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`}
          className="text-xs text-accent hover:text-accent/80 transition-colors font-medium"
        >
          Trade More →
        </Link>
      )}
    </div>
  );
}

export function PositionsTab() {
  const { data: positions = [], isLoading } = usePositions();
  const { costBasis } = useCostBasis();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  // Sort: winning settled positions first, then active, then losing settled
  const sortedPositions = useMemo(() => {
    return [...positions].sort((a, b) => {
      const aSettled = a.market.isSettled ? 1 : 0;
      const bSettled = b.market.isSettled ? 1 : 0;
      const aWinner = a.market.isSettled && (
        (a.market.outcome === 1 && a.yesBal > BigInt(0)) ||
        (a.market.outcome === 2 && a.noBal > BigInt(0))
      );
      const bWinner = b.market.isSettled && (
        (b.market.outcome === 1 && b.yesBal > BigInt(0)) ||
        (b.market.outcome === 2 && b.noBal > BigInt(0))
      );
      // Winning settled first, then active, then losing
      if (aWinner && !bWinner) return -1;
      if (!aWinner && bWinner) return 1;
      if (!aSettled && bSettled) return -1;
      if (aSettled && !bSettled) return 1;
      return 0;
    });
  }, [positions]);

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
      {sortedPositions.map((pos) => {
        const cb = costBasis.get(pos.market.publicKey.toBase58());
        return (
          <PositionCard
            key={pos.market.publicKey.toBase58()}
            position={pos}
            totalCost={cb?.totalCostUsdc ?? 0}
            now={now}
          />
        );
      })}
    </div>
  );
}
