/**
 * Historical volatility from OHLCV data — pure math, no external dependencies.
 *
 * Uses close-to-close log returns and annualises with 252 trading days/year.
 */

export interface OHLCVBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date: string;
}

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Annualised historical volatility from close-to-close log returns.
 *
 * @param bars   OHLCV bars in chronological order (oldest first).
 * @param windowDays  Number of trading days to use (default 30).
 *                    Uses the last `windowDays + 1` bars to produce `windowDays` returns.
 * @returns Annualised volatility as a decimal (e.g. 0.30 for 30%).
 *          Returns 0 if there are not enough bars.
 */
export function historicalVolatility(
  bars: OHLCVBar[],
  windowDays: number = 30,
): number {
  // Need at least windowDays + 1 bars to get windowDays returns
  if (bars.length < windowDays + 1) return 0;

  const slice = bars.slice(bars.length - windowDays - 1);
  const logReturns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0 || curr <= 0) continue;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < 2) return 0;

  const n = logReturns.length;
  const mean = logReturns.reduce((s, r) => s + r, 0) / n;
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1);

  return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}

/**
 * Rolling historical volatility series.
 *
 * For each position where enough history exists, computes the trailing
 * `windowDays`-day annualised HV.
 *
 * @param bars   OHLCV bars in chronological order (oldest first).
 * @param windowDays  Rolling window size in trading days (default 30).
 * @returns Array of { date, hv } starting from the first bar that has a full window.
 */
export function rollingVolatility(
  bars: OHLCVBar[],
  windowDays: number = 30,
): { date: string; hv: number }[] {
  const results: { date: string; hv: number }[] = [];

  // First valid output is at index windowDays (0-indexed), needing bars[0..windowDays]
  for (let i = windowDays; i < bars.length; i++) {
    const windowBars = bars.slice(i - windowDays, i + 1);
    const hv = historicalVolatility(windowBars, windowDays);
    results.push({ date: bars[i].date, hv });
  }

  return results;
}
