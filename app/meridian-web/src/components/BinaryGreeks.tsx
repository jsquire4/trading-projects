"use client";

/**
 * BinaryGreeks — flashy horizontal strip with animated pills and tooltips.
 * Sits between strike tabs and the order tree. Makes trading feel exciting.
 */

import { useMemo, useState } from "react";
import { binaryDelta, binaryGamma, binaryTheta, binaryVega, normalCdf, d2 } from "@/lib/greeks";

interface BinaryGreeksProps {
  spotPrice: number;
  strikePrice: number;
  volatility: number;
  timeToExpiry: number;
}

interface GreekDef {
  key: string;
  symbol: string;
  shortLabel?: string;
  symbolColor?: string;
  label: string;
  description: string;
  format: (v: number) => string;
  gradient: string;
  borderGlow: string;
}

function GreekPill({ def, value }: { def: GreekDef; value: number }) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className="relative group"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => setShowTooltip((p) => !p)}
    >
      {/* Pill body — overflow-hidden for shimmer only */}
      <div className={`relative flex items-center gap-1.5 rounded-lg border px-3 py-1.5 cursor-help transition-all duration-300 hover:scale-[1.03] ${def.borderGlow}`}>
        <div className="absolute inset-0 rounded-lg overflow-hidden">
          <div className={`absolute inset-0 opacity-50 group-hover:opacity-80 transition-opacity ${def.gradient}`} />
          <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
        </div>

        <span className={`relative text-sm font-bold transition-colors ${def.symbolColor ?? "text-white/60 group-hover:text-white/80"}`}>{def.symbol}</span>
        {def.shortLabel && (
          <span className="relative text-[10px] text-white/35 hidden sm:inline">{def.shortLabel}</span>
        )}
        <span className="relative text-sm font-mono font-bold tabular-nums text-white group-hover:text-white transition-colors">
          {def.format(value)}
        </span>
      </div>

      {/* Tooltip — rendered OUTSIDE the pill, not clipped */}
      {showTooltip && (
        <div
          className="fixed z-[9999] w-64 rounded-xl border border-white/20 bg-[#111] shadow-2xl shadow-black/50 px-4 py-3 text-xs"
          style={{
            // Position above the pill using JS since fixed positioning needs coordinates
            pointerEvents: "none",
          }}
          ref={(el) => {
            if (!el) return;
            const pill = el.parentElement?.querySelector("[class*=cursor-help]");
            if (!pill) return;
            const rect = pill.getBoundingClientRect();
            el.style.left = `${rect.left + rect.width / 2 - 128}px`;
            el.style.top = `${rect.top - el.offsetHeight - 8}px`;
          }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`text-sm ${def.symbolColor ?? ""}`}>{def.symbol}</span>
            <span className="font-bold text-white text-sm">{def.label}</span>
          </div>
          <p className="text-white/60 leading-relaxed">{def.description}</p>
        </div>
      )}
    </div>
  );
}

export function BinaryGreeks({
  spotPrice,
  strikePrice,
  volatility,
  timeToExpiry,
}: BinaryGreeksProps) {
  const greeks = useMemo(() => {
    if (spotPrice <= 0 || strikePrice <= 0 || volatility <= 0 || timeToExpiry <= 0) {
      return null;
    }

    const S = spotPrice;
    const K = strikePrice;
    const sigma = volatility;
    const T = timeToExpiry;

    const d2Val = d2(S, K, sigma, T);
    const prob = isNaN(d2Val) ? 0.5 : normalCdf(d2Val) * Math.exp(-0.05 * T);

    return {
      prob,
      delta: binaryDelta(S, K, sigma, T),
      gamma: binaryGamma(S, K, sigma, T),
      theta: binaryTheta(S, K, sigma, T),
      vega: binaryVega(S, K, sigma, T),
    };
  }, [spotPrice, strikePrice, volatility, timeToExpiry]);

  if (!greeks) return null;

  const bullish = greeks.prob >= 0.5;

  const defs: GreekDef[] = [
    {
      key: "prob",
      symbol: "●",
      symbolColor: bullish ? "text-green-400" : "text-red-400",
      shortLabel: "Implied Probability",
      label: "Implied Probability",
      description: `The market thinks there's a ${(greeks.prob * 100).toFixed(0)}% chance Yes wins. ${bullish ? "Odds favor the bulls!" : "Bears have the edge."} Derived from Black-Scholes using current price, strike, and volatility.`,
      format: (v) => `${(v * 100).toFixed(1)}%`,
      gradient: bullish ? "bg-gradient-to-r from-green-500/20 to-emerald-500/10" : "bg-gradient-to-r from-red-500/20 to-orange-500/10",
      borderGlow: bullish ? "border-green-500/30 shadow-[0_0_15px_rgba(34,197,94,0.15)]" : "border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.15)]",
    },
    {
      key: "delta",
      symbol: "Δ",
      label: "Delta — Price Sensitivity",
      description: "How much your contract moves per $1 stock move. High delta = you're riding the wave. Low delta = you're watching from shore.",
      format: (v) => v.toFixed(4),
      gradient: "bg-gradient-to-r from-blue-500/15 to-cyan-500/10",
      borderGlow: "border-blue-500/20 hover:shadow-[0_0_12px_rgba(59,130,246,0.15)]",
    },
    {
      key: "gamma",
      symbol: "Γ",
      label: "Gamma — Acceleration",
      description: "How fast delta changes. Near expiry with high gamma, one big stock move can flip your contract from worthless to winner. The 0DTE special.",
      format: (v) => v.toFixed(5),
      gradient: "bg-gradient-to-r from-purple-500/15 to-violet-500/10",
      borderGlow: "border-purple-500/20 hover:shadow-[0_0_12px_rgba(168,85,247,0.15)]",
    },
    {
      key: "theta",
      symbol: "θ",
      label: "Theta — Time Decay",
      description: "The clock is ticking. This is how much value bleeds away each day. For 0DTE contracts, theta is your biggest enemy if you're holding — and your best friend if you're selling.",
      format: (v) => `${(v * 365 * 100).toFixed(1)}¢`,
      gradient: "bg-gradient-to-r from-amber-500/15 to-yellow-500/10",
      borderGlow: "border-amber-500/20 hover:shadow-[0_0_12px_rgba(245,158,11,0.15)]",
    },
    {
      key: "vega",
      symbol: "V",
      label: "Vega — Volatility Edge",
      description: "How much you gain or lose when volatility spikes. Earnings? Fed announcement? High vega means you're positioned for chaos.",
      format: (v) => (v * 100).toFixed(3),
      gradient: "bg-gradient-to-r from-pink-500/15 to-rose-500/10",
      borderGlow: "border-pink-500/20 hover:shadow-[0_0_12px_rgba(236,72,153,0.15)]",
    },
  ];

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-hide">
      {defs.map((def) => (
        <GreekPill
          key={def.key}
          def={def}
          value={greeks[def.key as keyof typeof greeks]}
        />
      ))}
    </div>
  );
}
