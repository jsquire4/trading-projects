"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions, type Position } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { useCostBasis } from "@/hooks/useCostBasis";
import { InsightTooltip } from "@/components/InsightTooltip";
import { ShareButtons } from "@/components/ShareButtons";
import { interpretPosition } from "@/lib/insights";

interface MyPositionsProps {
  marketKey: string;
}

function PositionRow({ position, totalCost }: { position: Position; totalCost: number | null }) {
  const { data: book } = useOrderBook(position.market.publicKey.toBase58());

  const yesBal = Number(position.yesBal) / 1_000_000;
  const noBal = Number(position.noBal) / 1_000_000;

  // Estimate value from order book mid
  const midPrice = useMemo(() => {
    if (!book?.yesView.bestBid || !book?.yesView.bestAsk) return null;
    return (book.yesView.bestBid + book.yesView.bestAsk) / 2;
  }, [book]);

  const yesValue = midPrice !== null ? (yesBal * midPrice) / 100 : null;
  const noValue = midPrice !== null ? (noBal * (100 - midPrice)) / 100 : null;
  const totalValue = yesValue !== null || noValue !== null
    ? (yesValue ?? 0) + (noValue ?? 0)
    : null;

  const strikeDollars = Number(position.market.strikePrice) / 1_000_000;

  const closeUnix = Number(position.market.marketCloseUnix);
  const now = Math.floor(Date.now() / 1000);
  const minutesLeft = Math.max(0, (closeUnix - now) / 60);
  const side = yesBal > noBal ? "yes" : noBal > yesBal ? "no" : "balanced";
  const pnl = totalCost != null && totalValue !== null ? totalValue - totalCost : null;
  const positionInsight = pnl != null
    ? interpretPosition(side, pnl, minutesLeft)
    : undefined;

  return (
    <div className="flex items-center justify-between text-xs bg-white/5 rounded-md px-3 py-2.5">
      <div className="flex items-center gap-3">
        {positionInsight ? (
          <InsightTooltip insight={positionInsight}>
            <span className="text-white font-medium">{position.market.ticker}</span>
          </InsightTooltip>
        ) : (
          <span className="text-white font-medium">{position.market.ticker}</span>
        )}
        <span className="text-white/40 font-mono">${strikeDollars.toFixed(0)}</span>
      </div>
      <div className="flex items-center gap-4">
        {yesBal > 0 && (
          <span className="text-green-400 tabular-nums">{yesBal.toFixed(0)} Yes</span>
        )}
        {noBal > 0 && (
          <span className="text-red-400 tabular-nums">{noBal.toFixed(0)} No</span>
        )}
        {yesBal > 0 && noBal > 0 && yesBal === noBal && (
          <span className="text-blue-400/60 text-[10px]">Balanced</span>
        )}
        <span className="text-white/50 tabular-nums">
          {totalValue !== null ? `$${totalValue.toFixed(2)}` : "--"}
        </span>
        <ShareButtons
          ticker={position.market.ticker}
          side={side}
          payout={totalValue ?? undefined}
          marketUrl={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`}
        />
        <Link
          href={`/trade/${position.market.ticker}?market=${position.market.publicKey.toBase58()}`}
          className="text-accent hover:text-accent/80 transition-colors text-[11px] font-medium"
        >
          Trade
        </Link>
      </div>
    </div>
  );
}

export function MyPositions({ marketKey }: MyPositionsProps) {
  const { publicKey } = useWallet();
  const { data: positions = [], isLoading } = usePositions();
  const { costBasis } = useCostBasis();

  // Filter to this market
  const marketPositions = useMemo(
    () => positions.filter((p) => p.market.publicKey.toBase58() === marketKey),
    [positions, marketKey],
  );

  if (!publicKey) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Positions</h3>
        <p className="text-xs text-white/30">Connect wallet to view positions</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Positions</h3>
        <div className="animate-pulse h-8 rounded bg-white/10" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white/80 mb-2">My Positions</h3>
      {marketPositions.length === 0 ? (
        <p className="text-xs text-white/30">No positions in this market</p>
      ) : (
        <div className="space-y-1.5">
          {marketPositions.map((pos) => {
            const cb = costBasis.get(pos.market.publicKey.toBase58());
            return (
              <PositionRow
                key={pos.market.publicKey.toBase58()}
                position={pos}
                totalCost={cb?.totalCostUsdc ?? null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
