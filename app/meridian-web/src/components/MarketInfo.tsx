"use client";

import { useState, useEffect } from "react";
import type { ParsedMarket } from "@/hooks/useMarkets";

interface MarketInfoProps {
  market: ParsedMarket;
  currentPrice?: number;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Closed";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

export function MarketInfo({ market, currentPrice }: MarketInfoProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    // Stop ticking once the market has closed — the countdown is no longer needed.
    if (market.isSettled || Math.floor(Date.now() / 1000) >= Number(market.marketCloseUnix)) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [market.isSettled, market.marketCloseUnix]);

  const strikeDollars = Number(market.strikePrice) / 1_000_000;
  const closeUnix = Number(market.marketCloseUnix);
  const remaining = Math.max(0, closeUnix - now);
  const totalMinted = Number(market.totalMinted) / 1_000_000;
  const totalRedeemed = Number(market.totalRedeemed) / 1_000_000;

  // Distance from current price to strike
  const distance = currentPrice
    ? ((currentPrice - strikeDollars) / strikeDollars * 100).toFixed(1)
    : null;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-white/80">Market Info</h3>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-white/40">Strike</span>
          <div className="text-white font-mono font-medium">${strikeDollars.toFixed(2)}</div>
        </div>
        <div>
          <span className="text-white/40">Closes In</span>
          <div className="text-white font-mono font-medium">{formatCountdown(remaining)}</div>
        </div>
        <div>
          <span className="text-white/40">Total Pairs</span>
          <div className="text-white font-mono font-medium">{totalMinted.toLocaleString()} pairs</div>
        </div>
        <div>
          <span className="text-white/40">Total Redeemed</span>
          <div className="text-white font-mono font-medium">{totalRedeemed.toLocaleString()}</div>
        </div>
        {currentPrice && distance && (
          <div>
            <span className="text-white/40">Distance to Strike</span>
            <div className={`font-mono font-medium ${Number(distance) >= 0 ? "text-green-400" : "text-red-400"}`}>
              {Number(distance) >= 0 ? "+" : ""}{distance}%
            </div>
          </div>
        )}
        {false && (
          <div className="col-span-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-medium">
              PAUSED
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
