import { describe, it, expect } from "vitest";
import {
  OHLCVBar,
  historicalVolatility,
  rollingVolatility,
} from "../volatility";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a bar with the given close price and date index. */
function makeBar(close: number, index: number): OHLCVBar {
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    date: `2025-01-${String(index + 1).padStart(2, "0")}`,
  };
}

/**
 * Build a series of bars where each close is `factor` times the previous.
 * close[0] = startPrice, close[i] = close[i-1] * factor.
 */
function makeGeometricBars(
  startPrice: number,
  factor: number,
  count: number,
): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    bars.push(makeBar(price, i));
    price *= factor;
  }
  return bars;
}

// ---------------------------------------------------------------------------
// historicalVolatility
// ---------------------------------------------------------------------------

describe("historicalVolatility", () => {
  it("returns 0 when there are fewer bars than windowDays + 1", () => {
    // 30-day window needs 31 bars; provide only 10
    const bars = Array.from({ length: 10 }, (_, i) => makeBar(100, i));
    expect(historicalVolatility(bars, 30)).toBe(0);
  });

  it("returns 0 when all closing prices are identical (constant series)", () => {
    const bars = Array.from({ length: 31 }, (_, i) => makeBar(50, i));
    expect(historicalVolatility(bars, 30)).toBe(0);
  });

  it("computes correct HV for known 1% daily returns (30-day window)", () => {
    // 31 bars → 30 log returns, each = ln(1.01) ≈ 0.00995
    // All returns equal ⇒ stddev = 0 if we used population, but the code uses
    // sample variance (n-1). With identical returns the variance is 0.
    //
    // Actually: ln(1.01) is constant across all returns so std = 0!
    // We need varying returns. Let's instead alternate 1.02 and 1.00 to get
    // a known non-zero standard deviation.

    // Better approach: construct bars with known log returns.
    // Let returns be r_i for i in [0, 29].
    // Use alternating +0.01 and -0.01 log returns.
    const logReturns = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? 0.01 : -0.01,
    );
    // mean = 0, variance = sum(r^2) / (n-1) = 30 * 0.0001 / 29
    const expectedVariance = (30 * 0.0001) / 29;
    const expectedHV = Math.sqrt(expectedVariance * 252);

    // Build bars from log returns
    const bars: OHLCVBar[] = [];
    let price = 100;
    bars.push(makeBar(price, 0));
    for (let i = 0; i < logReturns.length; i++) {
      price *= Math.exp(logReturns[i]);
      bars.push(makeBar(price, i + 1));
    }

    const hv = historicalVolatility(bars, 30);
    expect(hv).toBeCloseTo(expectedHV, 6);
  });

  it("computes correct HV for steady 1% growth (uniform log returns)", () => {
    // 31 bars: close[i] = 100 * 1.01^i → all log returns = ln(1.01)
    // Sample stddev of a constant series = 0
    const bars = makeGeometricBars(100, 1.01, 31);
    expect(historicalVolatility(bars, 30)).toBeCloseTo(0, 10);
  });

  it("works with a 60-day window", () => {
    // 61 bars with alternating ±0.02 log returns
    const logReturns = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? 0.02 : -0.02,
    );
    const expectedVariance = (60 * 0.0004) / 59;
    const expectedHV = Math.sqrt(expectedVariance * 252);

    const bars: OHLCVBar[] = [];
    let price = 100;
    bars.push(makeBar(price, 0));
    for (let i = 0; i < logReturns.length; i++) {
      price *= Math.exp(logReturns[i]);
      bars.push(makeBar(price, i + 1));
    }

    const hv = historicalVolatility(bars, 60);
    expect(hv).toBeCloseTo(expectedHV, 6);
  });

  it("handles zero closes gracefully (skips them)", () => {
    // Insert a zero-close bar in the middle
    const bars = Array.from({ length: 31 }, (_, i) => makeBar(100, i));
    bars[15] = makeBar(0, 15);

    // Should not throw — may return 0 or a value depending on how many
    // valid returns remain. The key assertion: no error.
    const result = historicalVolatility(bars, 30);
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });

  it("handles negative closes gracefully (skips them)", () => {
    const bars = Array.from({ length: 31 }, (_, i) => makeBar(100, i));
    bars[10] = makeBar(-5, 10);

    const result = historicalVolatility(bars, 30);
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rollingVolatility
// ---------------------------------------------------------------------------

describe("rollingVolatility", () => {
  it("returns array of length bars.length - windowDays", () => {
    const bars = makeGeometricBars(100, 1.005, 50);
    const result = rollingVolatility(bars, 30);
    expect(result.length).toBe(50 - 30);
  });

  it("first entry date matches bar at index windowDays", () => {
    const bars = makeGeometricBars(100, 1.005, 50);
    const result = rollingVolatility(bars, 30);
    expect(result[0].date).toBe(bars[30].date);
  });

  it("each entry's hv matches calling historicalVolatility on its window", () => {
    // Build bars with some variability
    const logReturns = Array.from({ length: 49 }, (_, i) =>
      i % 3 === 0 ? 0.015 : i % 3 === 1 ? -0.01 : 0.005,
    );
    const bars: OHLCVBar[] = [];
    let price = 100;
    bars.push(makeBar(price, 0));
    for (let i = 0; i < logReturns.length; i++) {
      price *= Math.exp(logReturns[i]);
      bars.push(makeBar(price, i + 1));
    }

    const windowDays = 20;
    const rolling = rollingVolatility(bars, windowDays);

    for (let idx = 0; idx < rolling.length; idx++) {
      const barIdx = idx + windowDays;
      const windowBars = bars.slice(barIdx - windowDays, barIdx + 1);
      const expectedHV = historicalVolatility(windowBars, windowDays);
      expect(rolling[idx].hv).toBeCloseTo(expectedHV, 10);
      expect(rolling[idx].date).toBe(bars[barIdx].date);
    }
  });

  it("returns empty array when not enough bars", () => {
    const bars = makeGeometricBars(100, 1.01, 10);
    const result = rollingVolatility(bars, 30);
    expect(result).toEqual([]);
  });
});
