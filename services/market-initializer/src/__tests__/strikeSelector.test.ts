import { describe, it, expect } from "vitest";
import {
  generateBaselineStrikes,
  generateVolAwareStrikes,
  type StrikeResult,
} from "../strikeSelector.ts";
import type { OHLCVBar } from "../strikeSelector.ts";

// ---------------------------------------------------------------------------
// Helper: generate synthetic OHLCV bars with controlled log returns
// ---------------------------------------------------------------------------

/**
 * Generate N+1 bars where consecutive close-to-close log returns have a
 * known standard deviation. The first bar has `startClose` as its close.
 * Each subsequent bar's close is: prev * exp(dailyReturn), where
 * dailyReturn alternates ±magnitude to produce a predictable stdev.
 *
 * For a simple deterministic series with known volatility, we alternate
 * between +r and -r. The stdev of [+r, -r, +r, -r, ...] for N values is r
 * (since mean ≈ 0 for even N).
 */
function makeBars(
  count: number,
  startClose: number,
  dailyLogReturn: number = 0.01,
): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  let close = startClose;

  for (let i = 0; i < count; i++) {
    bars.push({
      open: close,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 1_000_000,
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    });
    // Alternate positive and negative returns
    const sign = i % 2 === 0 ? 1 : -1;
    close = close * Math.exp(sign * dailyLogReturn);
  }

  return bars;
}

/** Generate bars where all closes are the same (zero volatility). */
function makeConstantBars(count: number, price: number): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1_000_000,
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// generateBaselineStrikes
// ---------------------------------------------------------------------------

describe("generateBaselineStrikes", () => {
  it("AAPL at $185: 6 strikes at ±3/6/9%, rounded to $10", () => {
    const result = generateBaselineStrikes(185);
    expect(result.method).toBe("baseline");
    expect(result.hv20).toBeUndefined();

    // Expected raw: 185*0.91=168.35, 185*0.94=173.9, 185*0.97=179.45,
    //               185*1.03=190.55, 185*1.06=196.1, 185*1.09=201.65
    // Rounded to $10: 170, 170, 180, 190, 200, 200
    // Deduped: [170, 180, 190, 200]
    expect(result.strikes).toEqual([170, 180, 190, 200]);
  });

  it("TSLA at $85: rounded to $5 (stock < $100)", () => {
    const result = generateBaselineStrikes(85);
    expect(result.method).toBe("baseline");

    // Raw: 85*0.91=77.35, 85*0.94=79.9, 85*0.97=82.45,
    //      85*1.03=87.55, 85*1.06=90.1, 85*1.09=92.65
    // Rounded to $5: 75, 80, 80, 90, 90, 95
    // Center strike: roundToNearest(85, 5) = 85
    // Deduped: [75, 80, 85, 90, 95]
    expect(result.strikes).toEqual([75, 80, 85, 90, 95]);
  });

  it("AAPL at $230: includes ATM center strike $230", () => {
    const result = generateBaselineStrikes(230);
    expect(result.method).toBe("baseline");

    // Raw offsets: 209.3→210, 216.2→220, 223.1→220, 236.9→240, 243.8→240, 250.7→250
    // Center strike: roundToNearest(230, 10) = 230
    // Deduped: [210, 220, 230, 240, 250]
    expect(result.strikes).toEqual([210, 220, 230, 240, 250]);
    expect(result.strikes).toContain(230);
  });

  it("deduplication when strikes collide after rounding", () => {
    // With a very low price like $10, ±3% and ±6% both round to the same value
    const result = generateBaselineStrikes(10);
    // Raw: 10*0.91=9.1, 10*0.94=9.4, 10*0.97=9.7, 10*1.03=10.3, 10*1.06=10.6, 10*1.09=10.9
    // Rounded to $5: 10, 10, 10, 10, 10, 10
    // All collide → [10]
    expect(result.strikes).toEqual([10]);
    // Even with collisions, we get at least 1 strike
    expect(result.strikes.length).toBeGreaterThanOrEqual(1);
  });

  it("results are sorted ascending", () => {
    const result = generateBaselineStrikes(200);
    for (let i = 1; i < result.strikes.length; i++) {
      expect(result.strikes[i]).toBeGreaterThan(result.strikes[i - 1]);
    }
  });

  it("no duplicate values", () => {
    const result = generateBaselineStrikes(150);
    const unique = new Set(result.strikes);
    expect(unique.size).toBe(result.strikes.length);
  });

  it("$100 boundary: uses $10 rounding", () => {
    const result = generateBaselineStrikes(100);
    // All strikes should be multiples of 10
    for (const s of result.strikes) {
      expect(s % 10).toBe(0);
    }
  });

  it("$99 boundary: uses $5 rounding", () => {
    const result = generateBaselineStrikes(99);
    // All strikes should be multiples of 5
    for (const s of result.strikes) {
      expect(s % 5).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// generateVolAwareStrikes
// ---------------------------------------------------------------------------

describe("generateVolAwareStrikes", () => {
  it("with sufficient bars: generates sigma-based strikes", () => {
    // 25 bars is enough for HV20 (needs 21)
    const bars = makeBars(25, 185, 0.02);
    const result = generateVolAwareStrikes(185, bars);
    expect(result.method).toBe("vol-aware");
    expect(result.hv20).toBeDefined();
    expect(result.hv20!).toBeGreaterThan(0);
  });

  it("with insufficient bars (<21): falls back to baseline", () => {
    const bars = makeBars(15, 185, 0.02);
    const result = generateVolAwareStrikes(185, bars);
    expect(result.method).toBe("baseline");
    expect(result.hv20).toBeUndefined();
  });

  it("with exactly 21 bars: computes HV20", () => {
    const bars = makeBars(21, 185, 0.02);
    const result = generateVolAwareStrikes(185, bars);
    expect(result.method).toBe("vol-aware");
    expect(result.hv20).toBeGreaterThan(0);
  });

  it("with zero-vol bars (all same close): falls back to baseline", () => {
    const bars = makeConstantBars(25, 185);
    const result = generateVolAwareStrikes(185, bars);
    expect(result.method).toBe("baseline");
    expect(result.hv20).toBeUndefined();
  });

  it("strikes are sorted ascending", () => {
    const bars = makeBars(30, 200, 0.015);
    const result = generateVolAwareStrikes(200, bars);
    for (let i = 1; i < result.strikes.length; i++) {
      expect(result.strikes[i]).toBeGreaterThan(result.strikes[i - 1]);
    }
  });

  it("strikes are deduplicated", () => {
    const bars = makeBars(30, 100, 0.005); // Low vol → sigma levels may collide
    const result = generateVolAwareStrikes(100, bars);
    const unique = new Set(result.strikes);
    expect(unique.size).toBe(result.strikes.length);
  });

  it("hv20 field present for vol-aware, undefined for baseline", () => {
    const goodBars = makeBars(25, 150, 0.02);
    const volResult = generateVolAwareStrikes(150, goodBars);
    expect(volResult.hv20).toBeDefined();
    expect(typeof volResult.hv20).toBe("number");

    const badBars = makeBars(10, 150, 0.02);
    const baseResult = generateVolAwareStrikes(150, badBars);
    expect(baseResult.hv20).toBeUndefined();
  });

  it("method field correctly set", () => {
    const goodBars = makeBars(25, 150, 0.02);
    expect(generateVolAwareStrikes(150, goodBars).method).toBe("vol-aware");

    const badBars = makeBars(10, 150, 0.02);
    expect(generateVolAwareStrikes(150, badBars).method).toBe("baseline");
  });

  it("known HV20: feed bars producing ~30% annualized vol, verify placement", () => {
    // Target: HV20 ≈ 30% annualized
    // Daily vol = 30% / sqrt(252) ≈ 0.0189
    // For alternating +r, -r log returns, stdev = r (for even N with 0 mean)
    // So we need dailyLogReturn ≈ 0.0189
    const dailyVol = 0.30 / Math.sqrt(252);
    const bars = makeBars(21, 200, dailyVol);
    const result = generateVolAwareStrikes(200, bars);

    expect(result.method).toBe("vol-aware");
    // The computed HV20 should be approximately 30%
    expect(result.hv20!).toBeGreaterThan(0.20);
    expect(result.hv20!).toBeLessThan(0.45);

    // With dailyVol ≈ 1.89%, strikes at 1σ/1.5σ/2σ daily should be:
    // ±1σ: 200 ± 200*0.0189 = 200 ± 3.78 → rounded to $10: 200 (both)
    // ±1.5σ: 200 ± 5.67 → rounded to $10: 200 (both)  or 190/210
    // ±2σ: 200 ± 7.56 → rounded to $10: 190 and 210
    // So with rounding we should see strikes around 190, 200, 210
    expect(result.strikes.length).toBeGreaterThanOrEqual(1);
    // All strikes should be within reasonable range of 200
    for (const s of result.strikes) {
      expect(s).toBeGreaterThanOrEqual(180);
      expect(s).toBeLessThanOrEqual(220);
    }
  });

  it("stock < $100: uses $5 rounding", () => {
    const bars = makeBars(25, 85, 0.02);
    const result = generateVolAwareStrikes(85, bars);
    for (const s of result.strikes) {
      expect(s % 5).toBe(0);
    }
  });

  it("stock >= $100: uses $10 rounding", () => {
    const bars = makeBars(25, 200, 0.02);
    const result = generateVolAwareStrikes(200, bars);
    for (const s of result.strikes) {
      expect(s % 10).toBe(0);
    }
  });

  it("vol-aware includes ATM center strike", () => {
    const bars = makeBars(25, 230, 0.02);
    const result = generateVolAwareStrikes(230, bars);
    expect(result.method).toBe("vol-aware");
    // Center strike: roundToNearest(230, 10) = 230
    expect(result.strikes).toContain(230);
  });

  it("high volatility produces wider strike range", () => {
    const lowVolBars = makeBars(25, 200, 0.005);
    const highVolBars = makeBars(25, 200, 0.04);

    const lowResult = generateVolAwareStrikes(200, lowVolBars);
    const highResult = generateVolAwareStrikes(200, highVolBars);

    const lowRange =
      lowResult.strikes[lowResult.strikes.length - 1] - lowResult.strikes[0];
    const highRange =
      highResult.strikes[highResult.strikes.length - 1] -
      highResult.strikes[0];

    expect(highRange).toBeGreaterThanOrEqual(lowRange);
  });
});
