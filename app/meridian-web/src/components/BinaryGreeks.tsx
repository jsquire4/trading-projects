"use client";

/**
 * BinaryGreeks — displays delta, gamma, theta, vega for the selected strike.
 *
 * Uses the shared binary option greeks math. Shows values as a compact
 * horizontal row with tooltip explanations.
 */

import { useMemo } from "react";
import { binaryDelta, binaryGamma, binaryTheta, binaryVega, normalCdf, d2 } from "@/lib/greeks";

interface BinaryGreeksProps {
  /** Current spot price in dollars */
  spotPrice: number;
  /** Strike price in dollars */
  strikePrice: number;
  /** Annual volatility (decimal, e.g. 0.30) */
  volatility: number;
  /** Time to expiry in years (e.g. 6.5 hours = 6.5/8760) */
  timeToExpiry: number;
}

const GREEK_LABELS: { key: string; label: string; description: string; format: (v: number) => string }[] = [
  {
    key: "prob",
    label: "P(ITM)",
    description: "Probability the option finishes in-the-money",
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: "delta",
    label: "Delta",
    description: "Price sensitivity to a $1 move in the underlying",
    format: (v) => v.toFixed(4),
  },
  {
    key: "gamma",
    label: "Gamma",
    description: "Rate of change of delta per $1 move",
    format: (v) => v.toFixed(5),
  },
  {
    key: "theta",
    label: "Theta",
    description: "Daily time decay (cents lost per day)",
    format: (v) => `${(v * 365 * 100).toFixed(2)}¢/day`,
  },
  {
    key: "vega",
    label: "Vega",
    description: "Sensitivity to a 1% change in volatility",
    format: (v) => (v * 100).toFixed(3),
  },
];

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

  if (!greeks) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <p className="text-xs text-white/30 text-center">Greeks unavailable — waiting for market data</p>
      </div>
    );
  }

  const probColor = greeks.prob >= 0.5 ? "text-green-400" : "text-red-400";

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/10">
        <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Binary Greeks</h3>
      </div>
      <div className="grid grid-cols-5 divide-x divide-white/5">
        {GREEK_LABELS.map((g) => {
          const value = greeks[g.key as keyof typeof greeks];
          const isProb = g.key === "prob";

          return (
            <div
              key={g.key}
              className="px-3 py-3 text-center group relative"
              title={g.description}
            >
              <div className="text-[10px] text-white/30 uppercase tracking-wider mb-1">
                {g.label}
              </div>
              <div className={`text-sm font-mono font-medium tabular-nums ${isProb ? probColor : "text-white/80"}`}>
                {g.format(value)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
