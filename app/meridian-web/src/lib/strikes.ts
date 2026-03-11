// SYNC: services/shared/src/strikes.ts — keep identical
/**
 * Strike selection — pure math, no external dependencies.
 */

export interface StrikeSet {
  strikes: number[];
  previousClose: number;
}

/** Round a value to the nearest multiple of `nearest`. */
export function roundToNearest(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

/** Price-aware rounding increment: $10 for stocks >= $100, $5 for cheaper stocks. */
export function roundingIncrement(price: number): number {
  return price >= 100 ? 10 : 5;
}

/**
 * Generate strikes at ±3%, ±6%, ±9% from previous close.
 *
 * Each strike is rounded to the nearest $5 or $10 (depending on price level),
 * duplicates are removed, and the result is sorted ascending.
 */
export function generateStrikes(previousClose: number): StrikeSet {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const increment = roundingIncrement(previousClose);

  const rawStrikes = offsets.map((pct) =>
    roundToNearest(previousClose * (1 + pct), increment),
  );

  // Deduplicate and sort ascending
  const unique = [...new Set(rawStrikes)].sort((a, b) => a - b);

  return { strikes: unique, previousClose };
}
