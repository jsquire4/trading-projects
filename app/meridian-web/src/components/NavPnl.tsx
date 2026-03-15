"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePositions } from "@/hooks/usePositions";
import { useOrderBooks } from "@/hooks/useMarkets";
import { usePortfolioSnapshot } from "@/hooks/usePortfolioSnapshot";

export function NavPnl() {
  const { connected } = useWallet();
  const { data: positions = [] } = usePositions();

  // Batch-fetch order books to derive mid prices (FH-8 fix)
  const marketKeys = useMemo(
    () => positions.map((p) => p.market.publicKey),
    [positions],
  );
  const { data: orderBooks } = useOrderBooks(marketKeys);

  const midPrices = useMemo(() => {
    if (!orderBooks) return undefined;
    const map = new Map<string, number>();
    for (const [key, ob] of orderBooks) {
      const bid = ob.yesView.bestBid;
      const ask = ob.yesView.bestAsk;
      if (bid !== null && ask !== null) {
        map.set(key, (bid + ask) / 200); // cents to 0-1 scale
      } else if (bid !== null) {
        map.set(key, bid / 100);
      } else if (ask !== null) {
        map.set(key, ask / 100);
      }
    }
    return map.size > 0 ? map : undefined;
  }, [orderBooks]);

  const { todayPnl, isReady, approximate } = usePortfolioSnapshot(midPrices);

  if (!connected || !isReady) return null;

  const isPositive = todayPnl >= 0;
  const color = isPositive ? "text-green-400" : "text-red-400";
  const arrow = isPositive ? "▲" : "▼";

  return (
    <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-xs shrink-0">
      <span className="text-white/40">P&L{approximate ? "~" : ""}</span>
      <span className={`font-mono font-medium ${color}`}>
        {arrow} ${Math.abs(todayPnl).toFixed(2)}
      </span>
    </div>
  );
}
