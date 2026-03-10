"use client";

import { useState, useEffect, useMemo } from "react";

interface SettlementStatusProps {
  marketCloseUnix: number;
  isSettled: boolean;
  outcome: number; // 0 = unsettled, 1 = yes, 2 = no
  overrideDeadline: number; // unix timestamp when override window closes
  settlementPrice: number; // USDC lamports
  strikePrice: number; // USDC lamports
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function SettlementStatus({
  marketCloseUnix,
  isSettled,
  outcome,
  overrideDeadline,
  settlementPrice,
  strikePrice,
}: SettlementStatusProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const state = useMemo(() => {
    if (!isSettled) {
      return { phase: "countdown" as const, remaining: Math.max(0, marketCloseUnix - now) };
    }
    if (now < overrideDeadline) {
      return { phase: "override-window" as const };
    }
    return { phase: "final" as const };
  }, [isSettled, now, marketCloseUnix, overrideDeadline]);

  const settlePriceDollars = (settlementPrice / 1_000_000).toFixed(2);
  const outcomeLabel = outcome === 1 ? "Yes" : "No";

  if (state.phase === "countdown") {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
        <div className="text-xs text-white/50 mb-1">Market closes at {formatTime(marketCloseUnix)}</div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
          <span className="text-xl font-mono font-bold text-white">
            {formatCountdown(state.remaining)}
          </span>
        </div>
      </div>
    );
  }

  if (state.phase === "override-window") {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
          <span className="text-sm font-semibold text-yellow-400">Settlement Under Review</span>
        </div>
        <p className="text-xs text-yellow-300/70">
          Redemptions available at {formatTime(overrideDeadline)}
        </p>
      </div>
    );
  }

  // Final settled state
  const isYes = outcome === 1;
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        isYes
          ? "border-yes/30 bg-yes/10"
          : "border-no/30 bg-no/10"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className={`h-2 w-2 rounded-full ${isYes ? "bg-yes" : "bg-no"}`} />
        <span className={`text-sm font-semibold ${isYes ? "text-yes" : "text-no"}`}>
          Settled &mdash; {outcomeLabel} wins at ${settlePriceDollars}
        </span>
      </div>
      <p className="text-xs text-white/50">
        Strike: ${(strikePrice / 1_000_000).toFixed(2)}
      </p>
    </div>
  );
}
