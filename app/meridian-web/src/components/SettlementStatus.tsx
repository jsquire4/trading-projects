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

function formatSettlementDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }) + " at " + new Date(unix * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
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
      const remaining = Math.max(0, marketCloseUnix - now);
      if (now >= marketCloseUnix) {
        return { phase: "settling" as const };
      }
      if (remaining >= 12 * 3600) {
        return { phase: "next-day" as const };
      }
      return { phase: "live" as const, remaining };
    }
    if (now < overrideDeadline) {
      return { phase: "override-window" as const };
    }
    return { phase: "settled" as const };
  }, [isSettled, now, marketCloseUnix, overrideDeadline]);

  const settlePriceDollars = (settlementPrice / 1_000_000).toFixed(2);
  const outcomeLabel = outcome === 1 ? "Yes" : outcome === 2 ? "No" : "Pending";

  if (state.phase === "next-day") {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
        <div className="text-xs text-white/50 mb-1">Upcoming market</div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-blue-400" />
          <span className="text-sm font-medium text-white/70">
            Settles {formatSettlementDate(marketCloseUnix)}
          </span>
        </div>
      </div>
    );
  }

  if (state.phase === "live") {
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

  if (state.phase === "settling") {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <svg className="h-4 w-4 text-yellow-400 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-semibold text-yellow-400">Settlement in progress...</span>
        </div>
        <p className="text-xs text-yellow-300/70">
          Market closed at {formatTime(marketCloseUnix)}. Awaiting outcome.
        </p>
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

  // settled phase — outcome 0 means still finalizing
  if (outcome === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-2 w-2 rounded-full bg-white/40 animate-pulse" />
          <span className="text-sm font-semibold text-white/60">Settlement in progress</span>
        </div>
        <p className="text-xs text-white/40">Outcome is being determined.</p>
      </div>
    );
  }

  // Final settled state with known outcome
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
