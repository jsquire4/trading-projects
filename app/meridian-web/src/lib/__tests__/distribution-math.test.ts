import { describe, it, expect } from "vitest";
import {
  computeReturns,
  toWeeklyCloses,
  mean,
  stddev,
  normalPdf,
  buildHistogram,
} from "../distribution-math";

describe("mean", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("computes arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it("handles negative values", () => {
    expect(mean([-2, 2])).toBe(0);
  });
});

describe("stddev", () => {
  it("returns 0 for fewer than 2 elements", () => {
    expect(stddev([], 0)).toBe(0);
    expect(stddev([5], 5)).toBe(0);
  });

  it("computes sample standard deviation", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9], mean = 5, variance = 4, stddev = 2
    const arr = [2, 4, 4, 4, 5, 5, 7, 9];
    const mu = mean(arr);
    const sd = stddev(arr, mu);
    expect(sd).toBeCloseTo(2.138, 2);
  });
});

describe("normalPdf", () => {
  it("returns 0 for sigma <= 0", () => {
    expect(normalPdf(0, 0, 0)).toBe(0);
    expect(normalPdf(0, 0, -1)).toBe(0);
  });

  it("peaks at the mean", () => {
    const atMean = normalPdf(5, 5, 1);
    const offMean = normalPdf(6, 5, 1);
    expect(atMean).toBeGreaterThan(offMean);
  });

  it("returns correct value for standard normal at x=0", () => {
    // N(0; 0, 1) = 1/sqrt(2*pi) ~= 0.3989
    const val = normalPdf(0, 0, 1);
    expect(val).toBeCloseTo(0.3989, 3);
  });
});

describe("computeReturns", () => {
  it("returns empty for fewer than 2 elements", () => {
    expect(computeReturns([])).toEqual([]);
    expect(computeReturns([100])).toEqual([]);
  });

  it("computes percentage returns", () => {
    const returns = computeReturns([100, 110, 105]);
    expect(returns[0]).toBeCloseTo(10, 5);
    expect(returns[1]).toBeCloseTo(-4.5454, 2);
  });

  it("skips zero-valued previous closes", () => {
    const returns = computeReturns([0, 100, 110]);
    // First return skipped (division by 0), second is +10%
    expect(returns).toHaveLength(1);
    expect(returns[0]).toBeCloseTo(10, 5);
  });
});

describe("toWeeklyCloses", () => {
  it("returns empty for empty input", () => {
    expect(toWeeklyCloses([])).toEqual([]);
  });

  it("samples every 5th element and includes last", () => {
    const daily = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const weekly = toWeeklyCloses(daily);
    // indices 0, 5, 10 + last (11)
    expect(weekly).toEqual([1, 6, 11, 12]);
  });

  it("does not duplicate last element when evenly divisible", () => {
    const daily = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const weekly = toWeeklyCloses(daily);
    // indices 0, 5 + last (9) -- (10-1) % 5 = 4 !== 0, so last is added
    expect(weekly).toEqual([1, 6, 10]);
  });
});

describe("buildHistogram", () => {
  it("returns empty for empty returns", () => {
    expect(buildHistogram([], 0.25)).toEqual([]);
  });

  it("produces buckets with correct structure", () => {
    const returns = [0.1, 0.2, -0.1, 0.3, -0.2, 0.15, 0.05];
    const buckets = buildHistogram(returns, 0.25);
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      expect(b).toHaveProperty("label");
      expect(b).toHaveProperty("sigmaLabel");
      expect(b).toHaveProperty("center");
      expect(b).toHaveProperty("count");
      expect(b).toHaveProperty("frequency");
      expect(b).toHaveProperty("normal");
      expect(b.frequency).toBeGreaterThanOrEqual(0);
      expect(b.normal).toBeGreaterThanOrEqual(0);
    }
  });

  it("total counts equal input length", () => {
    const returns = [1, 2, 3, -1, -2, 0.5];
    const buckets = buildHistogram(returns, 1.0);
    const totalCount = buckets.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(returns.length);
  });
});
