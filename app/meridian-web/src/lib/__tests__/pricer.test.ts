import { describe, it, expect } from "vitest";
import {
  normalCdf,
  binaryCallPrice,
  probToCents,
  generateQuotes,
  shouldHalt,
} from "../pricer";

// ---------------------------------------------------------------------------
// normalCdf
// ---------------------------------------------------------------------------

describe("normalCdf", () => {
  it("returns ~0.5 for x=0", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });

  it("returns ~0.9987 for x=3", () => {
    expect(normalCdf(3)).toBeCloseTo(0.9987, 3);
  });

  it("returns ~0.0013 for x=-3", () => {
    expect(normalCdf(-3)).toBeCloseTo(0.0013, 3);
  });
});

// ---------------------------------------------------------------------------
// binaryCallPrice
// ---------------------------------------------------------------------------

describe("binaryCallPrice", () => {
  it("ATM binary (S=K) is approximately 0.5", () => {
    const price = binaryCallPrice(100, 100, 0.2, 0.5);
    expect(price).toBeGreaterThan(0.45);
    expect(price).toBeLessThan(0.55);
  });

  it("deep ITM (S >> K) is close to 1.0", () => {
    const price = binaryCallPrice(200, 100, 0.2, 0.5);
    expect(price).toBeGreaterThan(0.95);
  });

  it("deep OTM (S << K) is close to 0.0", () => {
    const price = binaryCallPrice(50, 100, 0.2, 0.5);
    expect(price).toBeLessThan(0.05);
  });

  it("T=0 returns 1.0 if S > K", () => {
    expect(binaryCallPrice(110, 100, 0.2, 0)).toBe(1.0);
  });

  it("T=0 returns 0.0 if S < K", () => {
    expect(binaryCallPrice(90, 100, 0.2, 0)).toBe(0.0);
  });

  it("T=0 returns 1.0 if S = K (at the money)", () => {
    expect(binaryCallPrice(100, 100, 0.2, 0)).toBe(1.0);
  });

  it("sigma=0 does not produce NaN or Infinity", () => {
    const price = binaryCallPrice(100, 100, 0, 0.5);
    expect(Number.isFinite(price)).toBe(true);
    expect(Number.isNaN(price)).toBe(false);
  });

  it("sigma=0, S > K returns 1.0", () => {
    expect(binaryCallPrice(110, 100, 0, 0.5)).toBe(1.0);
  });

  it("sigma=0, S < K returns 0.0", () => {
    expect(binaryCallPrice(90, 100, 0, 0.5)).toBe(0.0);
  });

  it("Yes + No sum to 1.0", () => {
    const yes = binaryCallPrice(105, 100, 0.25, 0.3);
    const no = 1 - yes;
    expect(yes + no).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// probToCents
// ---------------------------------------------------------------------------

describe("probToCents", () => {
  it("converts 0.65 to 65", () => {
    expect(probToCents(0.65)).toBe(65);
  });

  it("converts 0 to 0", () => {
    expect(probToCents(0)).toBe(0);
  });

  it("converts 1 to 100", () => {
    expect(probToCents(1)).toBe(100);
  });

  it("clamps negative to 0", () => {
    expect(probToCents(-0.1)).toBe(0);
  });

  it("clamps above 1 to 100", () => {
    expect(probToCents(1.5)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// generateQuotes
// ---------------------------------------------------------------------------

describe("generateQuotes", () => {
  it("zero inventory produces symmetric spread", () => {
    const result = generateQuotes(0.5, 0);
    const midpoint = (result.bidPrice + result.askPrice) / 2;
    // Midpoint should be very close to fair price in cents (within 1 cent)
    expect(Math.abs(midpoint - 50)).toBeLessThanOrEqual(1);
    expect(result.skew).toBeCloseTo(0);
    // Spread should be approximately symmetric (within 1 cent of rounding)
    const distBid = result.fairPrice * 100 - result.bidPrice;
    const distAsk = result.askPrice - result.fairPrice * 100;
    expect(Math.abs(distBid - distAsk)).toBeLessThanOrEqual(1);
  });

  it("positive inventory skews quotes lower (bid < fair < ask, skewed down)", () => {
    const result = generateQuotes(0.5, 200);
    // Positive inventory → negative skew → midpoint shifts down
    expect(result.skew).toBeLessThan(0);
    const midpoint = (result.bidPrice + result.askPrice) / 2;
    expect(midpoint).toBeLessThan(50);
  });

  it("negative inventory skews quotes higher", () => {
    const result = generateQuotes(0.5, -200);
    expect(result.skew).toBeGreaterThan(0);
    const midpoint = (result.bidPrice + result.askPrice) / 2;
    expect(midpoint).toBeGreaterThan(50);
  });

  it("bid is always less than ask", () => {
    const result = generateQuotes(0.5, 0);
    expect(result.bidPrice).toBeLessThan(result.askPrice);
  });

  it("prices stay within [1, 99]", () => {
    // Extreme inventory to stress boundaries
    const result = generateQuotes(0.5, 900);
    expect(result.bidPrice).toBeGreaterThanOrEqual(1);
    expect(result.askPrice).toBeLessThanOrEqual(99);
    expect(result.bidPrice).toBeLessThan(result.askPrice);
  });
});

// ---------------------------------------------------------------------------
// shouldHalt
// ---------------------------------------------------------------------------

describe("shouldHalt", () => {
  it("returns true when inventory exceeds max", () => {
    expect(shouldHalt(1001, 1000, 0)).toBe(true);
  });

  it("returns true when negative inventory exceeds max", () => {
    expect(shouldHalt(-1001, 1000, 0)).toBe(true);
  });

  it("returns true when consecutive errors exceed threshold", () => {
    expect(shouldHalt(0, 1000, 6)).toBe(true);
  });

  it("returns false when within limits", () => {
    expect(shouldHalt(500, 1000, 2)).toBe(false);
  });

  it("returns false at exact boundary", () => {
    expect(shouldHalt(1000, 1000, 5)).toBe(false);
  });
});
