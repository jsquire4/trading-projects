import { describe, it, expect } from "vitest";
import {
  normalPdf,
  normalCdf,
  d2,
  binaryDelta,
  binaryGamma,
  binaryTheta,
  binaryVega,
} from "../greeks.ts";

describe("normalPdf (re-exported)", () => {
  it("peaks at x=0 with value ~0.3989", () => {
    expect(normalPdf(0)).toBeCloseTo(0.3989, 3);
  });

  it("is symmetric", () => {
    expect(normalPdf(1)).toBeCloseTo(normalPdf(-1), 10);
    expect(normalPdf(2.5)).toBeCloseTo(normalPdf(-2.5), 10);
  });

  it("approaches 0 at tails", () => {
    expect(normalPdf(5)).toBeLessThan(0.001);
    expect(normalPdf(-5)).toBeLessThan(0.001);
  });
});

describe("normalCdf (re-exported)", () => {
  it("returns 0.5 at x=0", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });

  it("returns ~0.8413 at x=1", () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it("returns ~0.975 at x=1.96", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it("symmetry: cdf(x) + cdf(-x) = 1", () => {
    expect(normalCdf(-1)).toBeCloseTo(1 - normalCdf(1), 10);
  });

  it("approaches 0 for very negative x", () => {
    expect(normalCdf(-10)).toBe(0);
  });

  it("approaches 1 for very positive x", () => {
    expect(normalCdf(10)).toBe(1);
  });
});

describe("d2", () => {
  it("returns 0 when S=K and drift term cancels", () => {
    const sigma = Math.sqrt(0.1);
    expect(d2(100, 100, sigma, 1, 0.05)).toBeCloseTo(0, 5);
  });

  it("is positive when S >> K (deep ITM)", () => {
    expect(d2(200, 100, 0.3, 0.25)).toBeGreaterThan(0);
  });

  it("is negative when S << K (deep OTM)", () => {
    expect(d2(50, 100, 0.3, 0.25)).toBeLessThan(0);
  });
});

describe("binaryDelta", () => {
  it("ATM option has positive delta", () => {
    const delta = binaryDelta(100, 100, 0.3, 0.25);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeGreaterThan(0.01);
    expect(delta).toBeLessThan(0.1);
  });

  it("is positive for ITM", () => {
    expect(binaryDelta(110, 100, 0.3, 0.25)).toBeGreaterThan(0);
  });

  it("is positive for OTM", () => {
    expect(binaryDelta(90, 100, 0.3, 0.25)).toBeGreaterThan(0);
  });

  it("returns 0 for expired option (T=0)", () => {
    expect(binaryDelta(100, 100, 0.3, 0)).toBe(0);
  });

  it("returns 0 for zero vol", () => {
    expect(binaryDelta(100, 100, 0, 0.25)).toBe(0);
  });

  it("returns 0 for zero spot", () => {
    expect(binaryDelta(0, 100, 0.3, 0.25)).toBe(0);
  });
});

describe("binaryGamma", () => {
  it("returns 0 for expired option", () => {
    expect(binaryGamma(100, 100, 0.3, 0)).toBe(0);
  });

  it("returns 0 for zero vol", () => {
    expect(binaryGamma(100, 100, 0, 0.25)).toBe(0);
  });

  it("is non-zero for ATM with time remaining", () => {
    expect(binaryGamma(100, 100, 0.3, 0.25)).not.toBe(0);
  });

  it("ATM gamma is negative (binary call delta decreases through strike)", () => {
    expect(binaryGamma(100, 100, 0.3, 0.25)).toBeLessThan(0);
  });
});

describe("binaryTheta", () => {
  it("returns 0 for expired option (T=0)", () => {
    expect(binaryTheta(100, 100, 0.3, 0)).toBe(0);
  });

  it("returns 0 for zero vol", () => {
    expect(binaryTheta(100, 100, 0, 0.25)).toBe(0);
  });

  it("returns 0 for zero spot", () => {
    expect(binaryTheta(0, 100, 0.3, 0.25)).toBe(0);
  });

  it("ATM theta is negative (time decay hurts holder)", () => {
    expect(binaryTheta(100, 100, 0.3, 0.25)).toBeLessThan(0);
  });

  it("deep ITM theta is non-zero", () => {
    expect(binaryTheta(150, 100, 0.3, 0.25)).not.toBe(0);
  });
});

describe("binaryVega", () => {
  it("returns 0 for expired option (T=0)", () => {
    expect(binaryVega(100, 100, 0.3, 0)).toBe(0);
  });

  it("returns 0 for zero vol", () => {
    expect(binaryVega(100, 100, 0, 0.25)).toBe(0);
  });

  it("returns 0 for zero spot", () => {
    expect(binaryVega(0, 100, 0.3, 0.25)).toBe(0);
  });

  it("ATM vega is negative (higher vol reduces binary call value)", () => {
    expect(binaryVega(100, 100, 0.3, 0.25)).toBeLessThan(0);
  });

  it("deep ITM vega is negative", () => {
    expect(binaryVega(150, 100, 0.3, 0.25)).toBeLessThan(0);
  });

  it("deep OTM vega is positive", () => {
    expect(binaryVega(80, 100, 0.3, 0.25)).toBeGreaterThan(0);
  });
});
