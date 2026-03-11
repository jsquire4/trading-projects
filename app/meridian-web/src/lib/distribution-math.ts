/**
 * Pure math helpers for return distribution analysis.
 *
 * Extracted from HistoricalOverlay to enable reuse and unit testing.
 */

/** Compute percentage returns between consecutive values. */
export function computeReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
    }
  }
  return returns;
}

/** Downsample daily closes to weekly (every 5th trading day). */
export function toWeeklyCloses(closes: number[]): number[] {
  const weekly: number[] = [];
  for (let i = 0; i < closes.length; i += 5) {
    weekly.push(closes[i]);
  }
  // Always include the last point
  if (closes.length > 0 && (closes.length - 1) % 5 !== 0) {
    weekly.push(closes[closes.length - 1]);
  }
  return weekly;
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function stddev(arr: number[], mu: number): number {
  if (arr.length < 2) return 0;
  const variance =
    arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Normal PDF (not normalized to integrate to 1 -- scaled to match histogram). */
export function normalPdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return 0;
  return (
    Math.exp(-0.5 * ((x - mu) / sigma) ** 2) /
    (sigma * Math.sqrt(2 * Math.PI))
  );
}

export interface BucketRow {
  /** Bin center as percentage string, e.g. "-0.5%" */
  label: string;
  /** Sigma distance from mean, e.g. "-1.2sigma" */
  sigmaLabel: string;
  /** Bin center as number */
  center: number;
  /** Count of returns in this bucket */
  count: number;
  /** Frequency as percentage of total */
  frequency: number;
  /** Normal curve value (scaled to match histogram) */
  normal: number;
}

export function buildHistogram(
  returns: number[],
  binWidth: number,
): BucketRow[] {
  if (returns.length === 0) return [];

  const mu = mean(returns);
  const sigma = stddev(returns, mu);

  // Determine bin range: cover +/-4 sigma or the actual data range, whichever is wider
  const dataMin = Math.min(...returns);
  const dataMax = Math.max(...returns);
  const lo = Math.min(dataMin, mu - 4 * sigma);
  const hi = Math.max(dataMax, mu + 4 * sigma);

  const startBin = Math.floor(lo / binWidth) * binWidth;
  const endBin = Math.ceil(hi / binWidth) * binWidth;

  const buckets: BucketRow[] = [];
  for (let edge = startBin; edge < endBin; edge += binWidth) {
    const center = edge + binWidth / 2;
    const count = returns.filter(
      (r) => r >= edge && r < edge + binWidth,
    ).length;
    const frequency = (count / returns.length) * 100;

    // Normal curve scaled so area under curve ~= area under histogram
    const pdfVal = normalPdf(center, mu, sigma);
    const normalScaled = pdfVal * binWidth * 100; // scale to percentage

    const sigmas = sigma > 0 ? (center - mu) / sigma : 0;
    const sigmaStr =
      Math.abs(sigmas) < 0.05
        ? "\u03BC"
        : `${sigmas >= 0 ? "+" : ""}${sigmas.toFixed(1)}\u03C3`;

    buckets.push({
      label: `${center >= 0 ? "+" : ""}${center.toFixed(1)}%`,
      sigmaLabel: sigmaStr,
      center,
      count,
      frequency: Math.round(frequency * 10) / 10,
      normal: Math.round(normalScaled * 10) / 10,
    });
  }

  return buckets;
}
