// ---------------------------------------------------------------------------
// Vol-aware Strike Selector
//
// Enhances baseline ±3/6/9% strike generation with HV20-based sigma levels.
// When sufficient price history is available, strikes are placed at 1σ, 1.5σ,
// and 2σ daily moves from the previous close.
// ---------------------------------------------------------------------------

import { historicalVolatility, type OHLCVBar } from "../../shared/src/volatility.ts";

export type { OHLCVBar };

export interface StrikeResult {
  strikes: number[];
  method: "vol-aware" | "baseline";
  hv20?: number;
}

const TRADING_DAYS_PER_YEAR = 252;
const HV20_WINDOW = 20;

// Sigma multiples for strike placement
const SIGMA_LEVELS = [1, 1.5, 2];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Round a value to the nearest multiple of `nearest`.
 * Uses $10 rounding for stocks >= $100, $5 for stocks < $100.
 */
function roundToNearest(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

function roundingIncrement(price: number): number {
  return price >= 100 ? 10 : 5;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate strikes using the baseline ±3/6/9% method.
 *
 * Each strike is rounded to the nearest $5 or $10 (depending on price level),
 * duplicates are removed, and the result is sorted ascending.
 */
export function generateBaselineStrikes(previousClose: number): StrikeResult {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const increment = roundingIncrement(previousClose);

  const rawStrikes = offsets.map((pct) =>
    roundToNearest(previousClose * (1 + pct), increment),
  );

  const unique = [...new Set(rawStrikes)].sort((a, b) => a - b);

  return { strikes: unique, method: "baseline" };
}

/**
 * Generate vol-aware strikes using HV20-based sigma levels.
 *
 * Computes 20-day historical volatility, converts to a daily move, then
 * places strikes at ±1σ, ±1.5σ, ±2σ from the previous close.
 *
 * Falls back to baseline ±3/6/9% if HV20 cannot be computed (insufficient
 * bars or zero volatility).
 *
 * @param previousClose  Yesterday's closing price.
 * @param bars           OHLCV bars in chronological order (oldest first).
 *                       Should contain at least 21 bars for a valid HV20.
 */
export function generateVolAwareStrikes(
  previousClose: number,
  bars: OHLCVBar[],
): StrikeResult {
  const hv20 = historicalVolatility(bars, HV20_WINDOW);

  if (hv20 <= 0) {
    return generateBaselineStrikes(previousClose);
  }

  // Convert annualised vol to daily vol
  const dailyVol = hv20 / Math.sqrt(TRADING_DAYS_PER_YEAR);

  const increment = roundingIncrement(previousClose);

  const rawStrikes: number[] = [];

  for (const sigma of SIGMA_LEVELS) {
    const offset = sigma * dailyVol * previousClose;
    rawStrikes.push(roundToNearest(previousClose + offset, increment));
    rawStrikes.push(roundToNearest(previousClose - offset, increment));
  }

  // Deduplicate and sort ascending
  const unique = [...new Set(rawStrikes)].sort((a, b) => a - b);

  return { strikes: unique, method: "vol-aware", hv20 };
}
