"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { usePortfolioSnapshot } from "@/hooks/usePortfolioSnapshot";

export function NavPnl() {
  const { connected } = useWallet();
  const { todayPnl, currentValue, isReady, approximate } = usePortfolioSnapshot();

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
