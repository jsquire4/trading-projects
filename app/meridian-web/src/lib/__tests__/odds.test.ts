import { describe, it, expect } from "vitest";
import {
  formatOdds,
  centsToPercentage,
  centsToDecimalOdds,
  centsToFractionalOdds,
} from "../odds";

describe("formatOdds", () => {
  it('formats cents: formatOdds(65, "cents") → "65¢"', () => {
    expect(formatOdds(65, "cents")).toBe("65¢");
  });

  it('formats percentage: formatOdds(65, "percentage") → "65%"', () => {
    expect(formatOdds(65, "percentage")).toBe("65%");
  });

  it('formats decimal: formatOdds(65, "decimal") → "1.54"', () => {
    expect(formatOdds(65, "decimal")).toBe("1.54");
  });

  it('formats fractional: formatOdds(65, "fractional") → "35/65" simplified', () => {
    expect(formatOdds(65, "fractional")).toBe("7/13");
  });

  it('formats decimal at even money: formatOdds(50, "decimal") → "2.00"', () => {
    expect(formatOdds(50, "decimal")).toBe("2.00");
  });

  it('formats fractional at even money: formatOdds(50, "fractional") → "1/1"', () => {
    expect(formatOdds(50, "fractional")).toBe("1/1");
  });

  it('formats zero cents: formatOdds(0, "cents") → "0¢"', () => {
    expect(formatOdds(0, "cents")).toBe("0¢");
  });

  it('formats max cents: formatOdds(100, "cents") → "100¢"', () => {
    expect(formatOdds(100, "cents")).toBe("100¢");
  });

  it('formats max decimal: formatOdds(100, "decimal") → "1.00"', () => {
    expect(formatOdds(100, "decimal")).toBe("1.00");
  });
});

describe("centsToPercentage", () => {
  it("converts cents to percentage: centsToPercentage(65) → 65", () => {
    expect(centsToPercentage(65)).toBe(65);
  });
});

describe("centsToDecimalOdds", () => {
  it("converts 65 cents to decimal odds ≈ 1.538", () => {
    expect(centsToDecimalOdds(65)).toBeCloseTo(1.538, 2);
  });

  it("returns Infinity for 0 cents", () => {
    expect(centsToDecimalOdds(0)).toBe(Infinity);
  });

  it("returns Infinity for negative cents", () => {
    expect(centsToDecimalOdds(-5)).toBe(Infinity);
  });
});

describe("centsToFractionalOdds", () => {
  it('converts 75 cents → "1/3"', () => {
    expect(centsToFractionalOdds(75)).toBe("1/3");
  });

  it('converts 50 cents → "1/1"', () => {
    expect(centsToFractionalOdds(50)).toBe("1/1");
  });

  it('converts 25 cents → "3/1"', () => {
    expect(centsToFractionalOdds(25)).toBe("3/1");
  });

  it('returns "N/A" for 0 cents', () => {
    expect(centsToFractionalOdds(0)).toBe("N/A");
  });

  it('returns "N/A" for negative cents', () => {
    expect(centsToFractionalOdds(-5)).toBe("N/A");
  });
});

describe("formatOdds edge cases", () => {
  it('formats 0 cents decimal → "N/A"', () => {
    expect(formatOdds(0, "decimal")).toBe("N/A");
  });

  it('formats 0 cents fractional → "N/A"', () => {
    expect(formatOdds(0, "fractional")).toBe("N/A");
  });
});
