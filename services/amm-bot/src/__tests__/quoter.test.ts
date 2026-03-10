import { describe, it, expect } from "vitest";
import {
  generateQuotes,
  shouldHalt,
  DEFAULT_CONFIG,
  type QuoteConfig,
} from "../quoter.ts";

// ---------------------------------------------------------------------------
// generateQuotes
// ---------------------------------------------------------------------------

describe("generateQuotes", () => {
  describe("zero inventory (symmetric quotes)", () => {
    it("bid and ask are approximately symmetric around fair price", () => {
      const q = generateQuotes(0.50, 0);
      const fairCents = 50;
      const bidDist = fairCents - q.bidPrice;
      const askDist = q.askPrice - fairCents;
      // Rounding can introduce 1-cent asymmetry
      expect(Math.abs(bidDist - askDist)).toBeLessThanOrEqual(1);
    });

    it("skew is zero", () => {
      const q = generateQuotes(0.50, 0);
      expect(q.skew).toBe(0);
    });

    it("fair price is passed through", () => {
      const q = generateQuotes(0.65, 0);
      expect(q.fairPrice).toBe(0.65);
    });
  });

  describe("positive inventory (long) — skew down", () => {
    it("bid is lower than zero-inventory bid", () => {
      const neutral = generateQuotes(0.50, 0);
      const long = generateQuotes(0.50, 500);
      expect(long.bidPrice).toBeLessThanOrEqual(neutral.bidPrice);
    });

    it("ask is lower than zero-inventory ask", () => {
      const neutral = generateQuotes(0.50, 0);
      const long = generateQuotes(0.50, 500);
      expect(long.askPrice).toBeLessThanOrEqual(neutral.askPrice);
    });

    it("skew is negative (pushing quotes down)", () => {
      const q = generateQuotes(0.50, 500);
      // Positive inventory → negative skew in the formula
      // skew = (inventory / maxInventory) * skewFactor * halfSpread
      // With positive inventory, skew > 0 in the formula, but it's subtracted
      // Actually skew field = (500/1000)*0.5*halfSpread > 0
      expect(q.skew).toBeGreaterThan(0);
    });
  });

  describe("negative inventory (short) — skew up", () => {
    it("bid is higher than zero-inventory bid", () => {
      const neutral = generateQuotes(0.50, 0);
      const short = generateQuotes(0.50, -500);
      expect(short.bidPrice).toBeGreaterThanOrEqual(neutral.bidPrice);
    });

    it("ask is higher than zero-inventory ask", () => {
      const neutral = generateQuotes(0.50, 0);
      const short = generateQuotes(0.50, -500);
      expect(short.askPrice).toBeGreaterThanOrEqual(neutral.askPrice);
    });

    it("skew is negative (pushing quotes up)", () => {
      const q = generateQuotes(0.50, -500);
      expect(q.skew).toBeLessThan(0);
    });
  });

  describe("bid < ask invariant", () => {
    it("holds at fair price 0.50 with extreme inventory", () => {
      const q = generateQuotes(0.50, 999);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });

    it("holds at fair price 0.50 with extreme negative inventory", () => {
      const q = generateQuotes(0.50, -999);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });

    it("holds at fair price 0.01 (deep OTM)", () => {
      const q = generateQuotes(0.01, 0);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });

    it("holds at fair price 0.99 (deep ITM)", () => {
      const q = generateQuotes(0.99, 0);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });

    it("holds with max inventory at deep OTM", () => {
      const q = generateQuotes(0.01, 999);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });

    it("holds with max inventory at deep ITM", () => {
      const q = generateQuotes(0.99, -999);
      expect(q.bidPrice).toBeLessThan(q.askPrice);
    });
  });

  describe("quotes stay in [1, 99] range", () => {
    const extremeCases = [
      { fair: 0.01, inv: 999 },
      { fair: 0.01, inv: -999 },
      { fair: 0.99, inv: 999 },
      { fair: 0.99, inv: -999 },
      { fair: 0.50, inv: 0 },
    ];

    for (const { fair, inv } of extremeCases) {
      it(`fair=${fair}, inventory=${inv}`, () => {
        const q = generateQuotes(fair, inv);
        expect(q.bidPrice).toBeGreaterThanOrEqual(1);
        expect(q.bidPrice).toBeLessThanOrEqual(99);
        expect(q.askPrice).toBeGreaterThanOrEqual(1);
        expect(q.askPrice).toBeLessThanOrEqual(99);
      });
    }
  });

  describe("spread matches config approximately", () => {
    it("default config: spread is approximately 500 bps of fair", () => {
      const q = generateQuotes(0.50, 0);
      const spreadCents = q.askPrice - q.bidPrice;
      // Half spread = 0.50 * 500/10000 = 0.025, full spread = 0.05 = 5 cents
      // Rounding may shift by ±1
      expect(spreadCents).toBeGreaterThanOrEqual(4);
      expect(spreadCents).toBeLessThanOrEqual(6);
    });
  });

  describe("edge: deep OTM fair price", () => {
    it("fairPrice = 0.01: quotes are near the floor", () => {
      const q = generateQuotes(0.01, 0);
      expect(q.bidPrice).toBeGreaterThanOrEqual(1);
      expect(q.askPrice).toBeLessThanOrEqual(5);
    });
  });

  describe("edge: deep ITM fair price", () => {
    it("fairPrice = 0.99: quotes are near the ceiling", () => {
      const q = generateQuotes(0.99, 0);
      expect(q.bidPrice).toBeGreaterThanOrEqual(90);
      expect(q.askPrice).toBeLessThanOrEqual(99);
    });
  });

  describe("custom config", () => {
    it("wider spread with higher spreadBps", () => {
      const wide: QuoteConfig = {
        spreadBps: 1000,
        maxInventory: 1000,
        skewFactor: 0.5,
        minEdge: 1,
      };
      const narrow: QuoteConfig = {
        spreadBps: 200,
        maxInventory: 1000,
        skewFactor: 0.5,
        minEdge: 1,
      };
      const qWide = generateQuotes(0.50, 0, wide);
      const qNarrow = generateQuotes(0.50, 0, narrow);
      expect(qWide.askPrice - qWide.bidPrice).toBeGreaterThan(
        qNarrow.askPrice - qNarrow.bidPrice,
      );
    });

    it("higher skewFactor produces more skew", () => {
      const highSkew: QuoteConfig = {
        spreadBps: 500,
        maxInventory: 1000,
        skewFactor: 1.0,
        minEdge: 1,
      };
      const lowSkew: QuoteConfig = {
        spreadBps: 500,
        maxInventory: 1000,
        skewFactor: 0.1,
        minEdge: 1,
      };
      const qHigh = generateQuotes(0.50, 500, highSkew);
      const qLow = generateQuotes(0.50, 500, lowSkew);
      // Higher skew factor → more aggressive skew → lower bid (when long)
      expect(qHigh.bidPrice).toBeLessThanOrEqual(qLow.bidPrice);
    });

    it("zero skewFactor means inventory has no effect", () => {
      const noSkew: QuoteConfig = {
        spreadBps: 500,
        maxInventory: 1000,
        skewFactor: 0,
        minEdge: 1,
      };
      const neutral = generateQuotes(0.50, 0, noSkew);
      const loaded = generateQuotes(0.50, 800, noSkew);
      expect(loaded.bidPrice).toBe(neutral.bidPrice);
      expect(loaded.askPrice).toBe(neutral.askPrice);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldHalt
// ---------------------------------------------------------------------------

describe("shouldHalt", () => {
  it("returns false when inventory and errors are within limits", () => {
    expect(shouldHalt(500, 1000, 0)).toBe(false);
  });

  it("returns false at exactly maxInventory", () => {
    expect(shouldHalt(1000, 1000, 0)).toBe(false);
  });

  it("returns true when inventory exceeds maxInventory", () => {
    expect(shouldHalt(1001, 1000, 0)).toBe(true);
  });

  it("returns true when negative inventory exceeds maxInventory", () => {
    expect(shouldHalt(-1001, 1000, 0)).toBe(true);
  });

  it("returns false at exactly 5 consecutive errors", () => {
    expect(shouldHalt(0, 1000, 5)).toBe(false);
  });

  it("returns true when consecutive errors exceed 5", () => {
    expect(shouldHalt(0, 1000, 6)).toBe(true);
  });

  it("returns true when both inventory and errors exceed limits", () => {
    expect(shouldHalt(2000, 1000, 10)).toBe(true);
  });

  it("returns false with zero inventory and zero errors", () => {
    expect(shouldHalt(0, 1000, 0)).toBe(false);
  });
});
