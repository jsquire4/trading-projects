import { describe, it, expect } from "vitest";
import {
  generateQuotes,
  shouldHalt,
  DEFAULT_CONFIG,
  type QuoteConfig,
} from "../quoter.ts";

describe("generateQuotes", () => {
  it("zero inventory produces symmetric spread", () => {
    const q = generateQuotes(0.50, 0);
    const midpoint = (q.bidPrice + q.askPrice) / 2;
    expect(Math.abs(midpoint - 50)).toBeLessThanOrEqual(1);
    expect(q.skew).toBeCloseTo(0);
  });

  it("fair price is passed through", () => {
    const q = generateQuotes(0.65, 0);
    expect(q.fairPrice).toBe(0.65);
  });

  it("positive inventory → negative skew (shift quotes down)", () => {
    const result = generateQuotes(0.5, 200);
    expect(result.skew).toBeLessThan(0);
    const midpoint = (result.bidPrice + result.askPrice) / 2;
    expect(midpoint).toBeLessThan(50);
  });

  it("negative inventory → positive skew (shift quotes up)", () => {
    const result = generateQuotes(0.5, -200);
    expect(result.skew).toBeGreaterThan(0);
    const midpoint = (result.bidPrice + result.askPrice) / 2;
    expect(midpoint).toBeGreaterThan(50);
  });

  it("bid < ask invariant holds at extremes", () => {
    for (const inv of [999, -999, 0]) {
      for (const fair of [0.01, 0.50, 0.99]) {
        const q = generateQuotes(fair, inv);
        expect(q.bidPrice).toBeLessThan(q.askPrice);
      }
    }
  });

  it("quotes stay in [1, 99] range", () => {
    for (const fair of [0.01, 0.50, 0.99]) {
      for (const inv of [999, -999, 0]) {
        const q = generateQuotes(fair, inv);
        expect(q.bidPrice).toBeGreaterThanOrEqual(1);
        expect(q.bidPrice).toBeLessThanOrEqual(99);
        expect(q.askPrice).toBeGreaterThanOrEqual(1);
        expect(q.askPrice).toBeLessThanOrEqual(99);
      }
    }
  });

  it("default config spread is approximately 500 bps of fair", () => {
    const q = generateQuotes(0.50, 0);
    const spreadCents = q.askPrice - q.bidPrice;
    expect(spreadCents).toBeGreaterThanOrEqual(4);
    expect(spreadCents).toBeLessThanOrEqual(6);
  });

  it("wider spreadBps produces wider spread", () => {
    const wide: QuoteConfig = { spreadBps: 1000, maxInventory: 1000, skewFactor: 0.5, minEdge: 1 };
    const narrow: QuoteConfig = { spreadBps: 200, maxInventory: 1000, skewFactor: 0.5, minEdge: 1 };
    const qWide = generateQuotes(0.50, 0, wide);
    const qNarrow = generateQuotes(0.50, 0, narrow);
    expect(qWide.askPrice - qWide.bidPrice).toBeGreaterThan(qNarrow.askPrice - qNarrow.bidPrice);
  });

  it("zero skewFactor means inventory has no effect", () => {
    const noSkew: QuoteConfig = { spreadBps: 500, maxInventory: 1000, skewFactor: 0, minEdge: 1 };
    const neutral = generateQuotes(0.50, 0, noSkew);
    const loaded = generateQuotes(0.50, 800, noSkew);
    expect(loaded.bidPrice).toBe(neutral.bidPrice);
    expect(loaded.askPrice).toBe(neutral.askPrice);
  });
});

describe("shouldHalt", () => {
  it("returns false when within limits", () => {
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

  it("returns false with zero inventory and zero errors", () => {
    expect(shouldHalt(0, 1000, 0)).toBe(false);
  });
});
