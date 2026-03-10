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

/**
 * Generate strikes at ±3%, ±6%, ±9% from previous close.
 *
 * Each strike is rounded to the nearest $10, duplicates are removed,
 * and the result is sorted ascending.
 */
export function generateStrikes(previousClose: number): StrikeSet {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

  const rawStrikes = offsets.map((pct) =>
    roundToNearest(previousClose * (1 + pct), 10),
  );

  // Deduplicate and sort ascending
  const unique = [...new Set(rawStrikes)].sort((a, b) => a - b);

  return { strikes: unique, previousClose };
}
