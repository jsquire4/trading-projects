import { describe, it, expect } from "vitest";
import { normalPdf, normalCdf, binaryCallPrice, probToCents } from "../pricer.ts";

// ---------------------------------------------------------------------------
// normalCdf
// ---------------------------------------------------------------------------

describe("normalCdf", () => {
  it("cdf(0) = 0.5 (symmetry point)", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
  });

  it("is monotonically increasing", () => {
    const xs = [-3, -2, -1, 0, 1, 2, 3];
    for (let i = 1; i < xs.length; i++) {
      expect(normalCdf(xs[i])).toBeGreaterThan(normalCdf(xs[i - 1]));
    }
  });

  it("extreme negative value: cdf(-10) = 0", () => {
    expect(normalCdf(-10)).toBe(0);
  });

  it("extreme positive value: cdf(10) = 1", () => {
    expect(normalCdf(10)).toBe(1);
  });

  it("boundary clamp: cdf(-8) = 0, cdf(8) = 1", () => {
    expect(normalCdf(-8)).toBe(0);
    expect(normalCdf(8)).toBe(1);
  });

  it("beyond extreme: cdf(-15) = 0, cdf(15) = 1", () => {
    expect(normalCdf(-15)).toBe(0);
    expect(normalCdf(15)).toBe(1);
  });

  it("known value: cdf(1.96) ≈ 0.975", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it("known value: cdf(-1.96) ≈ 0.025", () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it("known value: cdf(1) ≈ 0.8413", () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it("known value: cdf(3) ≈ 0.9987", () => {
    expect(normalCdf(3)).toBeCloseTo(0.9987, 3);
  });

  it("known value: cdf(-3) ≈ 0.0013", () => {
    expect(normalCdf(-3)).toBeCloseTo(0.0013, 3);
  });

  it("symmetry: cdf(x) + cdf(-x) ≈ 1", () => {
    for (const x of [0.5, 1, 1.5, 2, 3]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// normalPdf
// ---------------------------------------------------------------------------

describe("normalPdf", () => {
  it("peak at x=0: pdf(0) = 1/sqrt(2π) ≈ 0.3989", () => {
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 10);
  });

  it("is symmetric: pdf(x) = pdf(-x)", () => {
    for (const x of [0.5, 1, 2, 3]) {
      expect(normalPdf(x)).toBeCloseTo(normalPdf(-x), 10);
    }
  });

  it("known value: pdf(1) ≈ 0.2420", () => {
    expect(normalPdf(1)).toBeCloseTo(0.2420, 3);
  });

  it("known value: pdf(2) ≈ 0.0540", () => {
    expect(normalPdf(2)).toBeCloseTo(0.0540, 3);
  });

  it("decreases away from 0", () => {
    expect(normalPdf(0)).toBeGreaterThan(normalPdf(1));
    expect(normalPdf(1)).toBeGreaterThan(normalPdf(2));
    expect(normalPdf(2)).toBeGreaterThan(normalPdf(3));
  });

  it("is always non-negative", () => {
    for (const x of [-5, -2, 0, 2, 5]) {
      expect(normalPdf(x)).toBeGreaterThanOrEqual(0);
    }
  });

  it("approaches 0 at tails", () => {
    expect(normalPdf(5)).toBeLessThan(0.001);
    expect(normalPdf(-5)).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// binaryCallPrice
// ---------------------------------------------------------------------------

describe("binaryCallPrice", () => {
  const sigma = 0.30;
  const T = 6.5 / 8760;
  const r = 0.05;

  it("ATM (S = K): probability near 0.50", () => {
    const price = binaryCallPrice(100, 100, sigma, T, r);
    expect(price).toBeGreaterThan(0.45);
    expect(price).toBeLessThan(0.55);
  });

  it("deep ITM (S >> K): probability near 1.0", () => {
    const price = binaryCallPrice(200, 100, sigma, T, r);
    expect(price).toBeGreaterThan(0.95);
  });

  it("deep OTM (S << K): probability near 0.0", () => {
    const price = binaryCallPrice(50, 100, sigma, T, r);
    expect(price).toBeLessThan(0.05);
  });

  it("T=0, S > K → 1.0 (expired ITM)", () => {
    expect(binaryCallPrice(101, 100, sigma, 0, r)).toBe(1.0);
  });

  it("T=0, S < K → 0.0 (expired OTM)", () => {
    expect(binaryCallPrice(99, 100, sigma, 0, r)).toBe(0.0);
  });

  it("T=0, S = K → 1.0 (at-the-money at expiry resolves ITM)", () => {
    expect(binaryCallPrice(100, 100, sigma, 0, r)).toBe(1.0);
  });

  it("sigma=0, S > K → 1.0", () => {
    expect(binaryCallPrice(110, 100, 0, T, r)).toBe(1.0);
  });

  it("sigma=0, S < K → 0.0", () => {
    expect(binaryCallPrice(90, 100, 0, T, r)).toBe(0.0);
  });

  it("sigma=0, S = K → 1.0", () => {
    expect(binaryCallPrice(100, 100, 0, T, r)).toBe(1.0);
  });

  it("S=0 → 0.0 (worthless underlying)", () => {
    expect(binaryCallPrice(0, 100, sigma, T, r)).toBe(0.0);
  });

  it("S negative → 0.0", () => {
    expect(binaryCallPrice(-10, 100, sigma, T, r)).toBe(0.0);
  });

  it("very small T (5 minutes), S well above K → near 1.0", () => {
    const fiveMinutes = 5 / (365.25 * 24 * 60);
    const price = binaryCallPrice(110, 100, sigma, fiveMinutes, r);
    expect(price).toBeGreaterThan(0.95);
  });

  it("very small T (5 minutes), S well below K → near 0.0", () => {
    const fiveMinutes = 5 / (365.25 * 24 * 60);
    const price = binaryCallPrice(90, 100, sigma, fiveMinutes, r);
    expect(price).toBeLessThan(0.05);
  });

  it("very small T, S exactly at K → near 0.50", () => {
    const fiveMinutes = 5 / (365.25 * 24 * 60);
    const price = binaryCallPrice(100, 100, sigma, fiveMinutes, r);
    expect(price).toBeGreaterThan(0.40);
    expect(price).toBeLessThan(0.60);
  });

  it("result is always clamped to [0, 1]", () => {
    const cases = [
      { S: 1000, K: 1, sigma: 0.01, T: 1, r: 0 },
      { S: 1, K: 1000, sigma: 0.01, T: 1, r: 0 },
      { S: 100, K: 100, sigma: 5, T: 10, r: 0 },
    ];
    for (const c of cases) {
      const price = binaryCallPrice(c.S, c.K, c.sigma, c.T, c.r);
      expect(price).toBeGreaterThanOrEqual(0);
      expect(price).toBeLessThanOrEqual(1);
    }
  });

  it("sigma=0 does not produce NaN or Infinity", () => {
    const price = binaryCallPrice(100, 100, 0, 0.5);
    expect(Number.isFinite(price)).toBe(true);
    expect(Number.isNaN(price)).toBe(false);
  });

  it("Yes + No sum to ~1.0", () => {
    const yes = binaryCallPrice(105, 100, 0.25, 0.3);
    const no = 1 - yes;
    expect(yes + no).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// probToCents
// ---------------------------------------------------------------------------

describe("probToCents", () => {
  it("maps 0.50 → 50", () => {
    expect(probToCents(0.5)).toBe(50);
  });

  it("maps 0.01 → 1", () => {
    expect(probToCents(0.01)).toBe(1);
  });

  it("maps 0.99 → 99", () => {
    expect(probToCents(0.99)).toBe(99);
  });

  it("maps 0.65 → 65", () => {
    expect(probToCents(0.65)).toBe(65);
  });

  it("maps 0.10 → 10", () => {
    expect(probToCents(0.1)).toBe(10);
  });

  it("rounds correctly: 0.255 → 26, 0.254 → 25", () => {
    expect(probToCents(0.255)).toBe(26);
    expect(probToCents(0.254)).toBe(25);
  });

  it("clamps below minimum: 0.001 → 1", () => {
    expect(probToCents(0.001)).toBe(1);
  });

  it("clamps above maximum: 0.999 → 99", () => {
    expect(probToCents(0.999)).toBe(99);
  });

  it("clamps 0 → 1", () => {
    expect(probToCents(0)).toBe(1);
  });

  it("clamps 1.0 → 99", () => {
    expect(probToCents(1.0)).toBe(99);
  });

  it("clamps negative → 1", () => {
    expect(probToCents(-0.5)).toBe(1);
  });

  it("clamps above 1 → 99", () => {
    expect(probToCents(1.5)).toBe(99);
  });
});
