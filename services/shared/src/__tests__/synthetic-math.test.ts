// ---------------------------------------------------------------------------
// Synthetic Math Tests — RNG determinism, GBM properties, hash seeding
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  SeededRng,
  hashSeed,
  gbmStep,
  generateBars,
  BASE_PRICES,
  DEFAULT_PRICE,
  DEFAULT_VOL,
  DEFAULT_DRIFT,
} from "../synthetic-config";

// ---- SeededRng --------------------------------------------------------------

describe("SeededRng", () => {
  it("produces deterministic sequence from same seed", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("produces different sequences from different seeds", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(99);
    const aVals = Array.from({ length: 10 }, () => a.next());
    const bVals = Array.from({ length: 10 }, () => b.next());
    // At least some values should differ
    const allSame = aVals.every((v, i) => v === bVals[i]);
    expect(allSame).toBe(false);
  });

  it("next() returns values in [0, 1)", () => {
    const rng = new SeededRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextGaussian() has mean ≈ 0 and std ≈ 1 over many samples", () => {
    const rng = new SeededRng(42);
    const N = 10_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const z = rng.nextGaussian();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(mean).toBeCloseTo(0, 1); // within 0.05
    expect(variance).toBeCloseTo(1, 0); // within 0.5
  });

  it("nextGaussian() is deterministic", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    for (let i = 0; i < 50; i++) {
      expect(a.nextGaussian()).toBe(b.nextGaussian());
    }
  });

  it("handles seed = 0 gracefully (defaults to 1)", () => {
    const rng = new SeededRng(0);
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it("handles negative seed", () => {
    const rng = new SeededRng(-42);
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

// ---- hashSeed ---------------------------------------------------------------

describe("hashSeed", () => {
  it("produces deterministic output for same inputs", () => {
    expect(hashSeed(42, "AAPL")).toBe(hashSeed(42, "AAPL"));
  });

  it("produces different output for different symbols", () => {
    expect(hashSeed(42, "AAPL")).not.toBe(hashSeed(42, "TSLA"));
  });

  it("produces different output for different seeds", () => {
    expect(hashSeed(42, "AAPL")).not.toBe(hashSeed(99, "AAPL"));
  });

  it("never returns 0", () => {
    // Empty string edge case
    const result = hashSeed(0, "");
    expect(result).not.toBe(0);
  });
});

// ---- gbmStep ----------------------------------------------------------------

describe("gbmStep", () => {
  it("returns a positive price", () => {
    const rng = new SeededRng(42);
    const price = gbmStep(100, rng);
    expect(price).toBeGreaterThan(0);
  });

  it("is deterministic with same RNG state", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    expect(gbmStep(100, a)).toBe(gbmStep(100, b));
  });

  it("uses default parameters (sigma=0.30, dt=1/252, mu=0)", () => {
    const rng = new SeededRng(42);
    const price = gbmStep(100, rng);
    // With default params, price should be close to 100 (small dt)
    expect(price).toBeGreaterThan(90);
    expect(price).toBeLessThan(110);
  });

  it("higher volatility produces larger moves on average", () => {
    const N = 1000;
    let lowVolDev = 0;
    let highVolDev = 0;

    for (let i = 0; i < N; i++) {
      const rngLow = new SeededRng(i);
      const rngHigh = new SeededRng(i);
      const pLow = gbmStep(100, rngLow, 0.10);
      const pHigh = gbmStep(100, rngHigh, 0.80);
      lowVolDev += Math.abs(pLow - 100);
      highVolDev += Math.abs(pHigh - 100);
    }

    expect(highVolDev / N).toBeGreaterThan(lowVolDev / N);
  });

  it("respects custom drift", () => {
    // Large positive drift over large dt should push price up on average
    const N = 1000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const rng = new SeededRng(i);
      sum += gbmStep(100, rng, 0.01, 1.0, 0.50); // 50% drift, 1 year, low vol
    }
    expect(sum / N).toBeGreaterThan(130); // Should be around e^0.5 * 100 ≈ 165
  });
});

// ---- generateBars -----------------------------------------------------------

describe("generateBars", () => {
  it("returns the requested number of bars", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 30, rng);
    expect(bars).toHaveLength(30);
  });

  it("each bar has required OHLCV fields", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 5, rng);
    for (const bar of bars) {
      expect(bar).toHaveProperty("date");
      expect(bar).toHaveProperty("open");
      expect(bar).toHaveProperty("high");
      expect(bar).toHaveProperty("low");
      expect(bar).toHaveProperty("close");
      expect(bar).toHaveProperty("volume");
    }
  });

  it("high >= open and high >= close for each bar", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 50, rng);
    for (const bar of bars) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.open);
      expect(bar.high).toBeGreaterThanOrEqual(bar.close);
    }
  });

  it("low <= open and low <= close for each bar", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 50, rng);
    for (const bar of bars) {
      expect(bar.low).toBeLessThanOrEqual(bar.open);
      expect(bar.low).toBeLessThanOrEqual(bar.close);
    }
  });

  it("prices are rounded to 2 decimal places", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 10, rng);
    for (const bar of bars) {
      expect(bar.open).toBe(Math.round(bar.open * 100) / 100);
      expect(bar.high).toBe(Math.round(bar.high * 100) / 100);
      expect(bar.low).toBe(Math.round(bar.low * 100) / 100);
      expect(bar.close).toBe(Math.round(bar.close * 100) / 100);
    }
  });

  it("is deterministic with same seed", () => {
    const a = generateBars(100, 10, new SeededRng(42));
    const b = generateBars(100, 10, new SeededRng(42));
    expect(a).toEqual(b);
  });

  it("dates are weekdays (no weekends)", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 50, rng);
    for (const bar of bars) {
      // Parse with midday offset to avoid UTC/local timezone day shift
      const day = new Date(bar.date + "T12:00:00").getDay();
      expect(day).not.toBe(0); // Sunday
      expect(day).not.toBe(6); // Saturday
    }
  });

  it("volumes are positive integers", () => {
    const rng = new SeededRng(42);
    const bars = generateBars(100, 20, rng);
    for (const bar of bars) {
      expect(bar.volume).toBeGreaterThan(0);
      expect(Number.isInteger(bar.volume)).toBe(true);
    }
  });
});

// ---- Constants --------------------------------------------------------------

describe("constants", () => {
  it("BASE_PRICES has expected tickers", () => {
    expect(BASE_PRICES).toHaveProperty("AAPL");
    expect(BASE_PRICES).toHaveProperty("TSLA");
    expect(BASE_PRICES).toHaveProperty("AMZN");
    expect(BASE_PRICES).toHaveProperty("MSFT");
    expect(BASE_PRICES).toHaveProperty("NVDA");
    expect(BASE_PRICES).toHaveProperty("GOOGL");
    expect(BASE_PRICES).toHaveProperty("META");
  });

  it("DEFAULT_PRICE is 100", () => {
    expect(DEFAULT_PRICE).toBe(100);
  });

  it("DEFAULT_VOL is 0.30", () => {
    expect(DEFAULT_VOL).toBe(0.30);
  });

  it("DEFAULT_DRIFT is 0.0", () => {
    expect(DEFAULT_DRIFT).toBe(0.0);
  });
});
