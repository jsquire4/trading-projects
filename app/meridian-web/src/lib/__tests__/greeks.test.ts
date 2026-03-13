import { describe, it, expect } from "vitest";
import {
  normalPdf,
  normalCdf,
  d2,
  binaryDelta,
  binaryGamma,
  binaryTheta,
  binaryVega,
} from "../greeks";

describe("normalPdf", () => {
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

describe("normalCdf", () => {
  it("returns 0.5 at x=0", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });

  it("returns ~0.8413 at x=1", () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it("returns ~0.975 at x=1.96", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it("returns ~0.16 at x=-1 (symmetric with x=1)", () => {
    const val = normalCdf(-1);
    // Should be approximately 1 - normalCdf(1)
    expect(val).toBeCloseTo(1 - normalCdf(1), 10);
  });

  it("approaches 0 for very negative x", () => {
    expect(normalCdf(-10)).toBe(0);
  });

  it("approaches 1 for very positive x", () => {
    expect(normalCdf(10)).toBe(1);
  });
});

describe("binaryDelta", () => {
  it("ATM option has delta around 0.5 area (positive)", () => {
    // S=K, moderate vol, some time left
    const delta = binaryDelta(100, 100, 0.3, 0.25);
    expect(delta).toBeGreaterThan(0);
    // Binary delta at ATM is N'(d2)/(S*sigma*sqrt(T)) which is significant
    expect(delta).toBeGreaterThan(0.01);
    expect(delta).toBeLessThan(0.1);
  });

  it("is in a reasonable positive range for ITM", () => {
    const delta = binaryDelta(110, 100, 0.3, 0.25);
    expect(delta).toBeGreaterThan(0);
  });

  it("is in a reasonable positive range for OTM", () => {
    const delta = binaryDelta(90, 100, 0.3, 0.25);
    expect(delta).toBeGreaterThan(0);
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
    const gamma = binaryGamma(100, 100, 0.3, 0.25);
    expect(gamma).not.toBe(0);
  });

  it("ATM gamma is negative (binary call delta decreases through strike)", () => {
    // Binary call delta peaks slightly before the strike and the
    // analytical formula yields negative gamma near ATM
    const gamma = binaryGamma(100, 100, 0.3, 0.25);
    expect(gamma).toBeLessThan(0);
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
    // For an ATM binary call, theta is typically negative as time decay
    // reduces the probability of finishing ITM
    const theta = binaryTheta(100, 100, 0.3, 0.25);
    expect(theta).toBeLessThan(0);
  });

  it("deep ITM theta is non-zero", () => {
    const theta = binaryTheta(150, 100, 0.3, 0.25);
    expect(theta).not.toBe(0);
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

  it("ATM vega is negative (higher vol reduces binary call value at ATM)", () => {
    // For a binary call, ATM vega is negative: increasing vol spreads the
    // distribution, reducing the peaked probability at the strike
    const vega = binaryVega(100, 100, 0.3, 0.25);
    expect(vega).toBeLessThan(0);
  });

  it("deep ITM vega is negative (vol reduces certainty)", () => {
    const vega = binaryVega(150, 100, 0.3, 0.25);
    expect(vega).toBeLessThan(0);
  });

  it("deep OTM vega is positive (vol increases upside chance)", () => {
    const vega = binaryVega(80, 100, 0.3, 0.25);
    expect(vega).toBeGreaterThan(0);
  });
});

describe("d2", () => {
  it("returns 0 when S=K and drift term cancels", () => {
    // d2 = [ln(1) + (r - sigma^2/2)*T] / (sigma*sqrt(T))
    // For S=K: d2 = (r - sigma^2/2)*T / (sigma*sqrt(T))
    // With r=0.05, sigma=sqrt(0.1) ≈ 0.3162, T=1:
    // d2 = (0.05 - 0.05)*1 / (0.3162*1) = 0
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
