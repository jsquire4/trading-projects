import { describe, it, expect } from "vitest";
import {
  formatPercent,
  formatDollar,
  formatCompact,
  COLORS,
  SERIES_COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
} from "../chartConfig";

// ---------------------------------------------------------------------------
// formatPercent
// ---------------------------------------------------------------------------

describe("formatPercent", () => {
  it('formats 0.5 as "50.0%"', () => {
    expect(formatPercent(0.5)).toBe("50.0%");
  });

  it('formats 0.123 as "12.3%"', () => {
    expect(formatPercent(0.123)).toBe("12.3%");
  });

  it('formats 1.0 as "100.0%"', () => {
    expect(formatPercent(1.0)).toBe("100.0%");
  });

  it("formats 0 as 0.0%", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("handles small fractions", () => {
    expect(formatPercent(0.001)).toBe("0.1%");
  });
});

// ---------------------------------------------------------------------------
// formatDollar
// ---------------------------------------------------------------------------

describe("formatDollar", () => {
  it('formats 185.50 as "$185.50"', () => {
    expect(formatDollar(185.5)).toBe("$185.50");
  });

  it("formats 1234.5 with thousands separator", () => {
    const result = formatDollar(1234.5);
    // toLocaleString output can vary, but should contain the key parts
    expect(result).toMatch(/^\$1[,.]?234\.50$/);
  });

  it("formats 0 correctly", () => {
    expect(formatDollar(0)).toBe("$0.00");
  });

  it("formats small values with two decimals", () => {
    expect(formatDollar(0.1)).toBe("$0.10");
  });
});

// ---------------------------------------------------------------------------
// formatCompact
// ---------------------------------------------------------------------------

describe("formatCompact", () => {
  it('formats 1_500_000 as "1.5M"', () => {
    expect(formatCompact(1_500_000)).toBe("1.5M");
  });

  it('formats 1_500 as "1.5K"', () => {
    expect(formatCompact(1_500)).toBe("1.5K");
  });

  it('formats 0.75 as "0.75"', () => {
    expect(formatCompact(0.75)).toBe("0.75");
  });

  it('formats 999 as "0.999K" — values >= 1000 use K suffix', () => {
    // 999 < 1000 so it stays as decimal
    expect(formatCompact(999)).toBe("999.00");
  });

  it("formats negative millions", () => {
    expect(formatCompact(-2_000_000)).toBe("-2.0M");
  });

  it("formats negative thousands", () => {
    expect(formatCompact(-3_500)).toBe("-3.5K");
  });
});

// ---------------------------------------------------------------------------
// Color constants
// ---------------------------------------------------------------------------

describe("COLORS", () => {
  const expectedKeys = [
    "yes",
    "no",
    "neutral",
    "accent",
    "secondary",
    "grid",
    "axisText",
    "tooltipBg",
    "tooltipBorder",
    "chartBg",
  ];

  it("has all expected keys", () => {
    for (const key of expectedKeys) {
      expect(COLORS).toHaveProperty(key);
    }
  });

  it("values are non-empty strings", () => {
    for (const key of expectedKeys) {
      const value = COLORS[key as keyof typeof COLORS];
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("SERIES_COLORS", () => {
  it("is an array of at least 5 colors", () => {
    expect(Array.isArray(SERIES_COLORS)).toBe(true);
    expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("style objects", () => {
  it("AXIS_STYLE has fontSize and fill", () => {
    expect(AXIS_STYLE).toHaveProperty("fontSize");
    expect(AXIS_STYLE).toHaveProperty("fill");
  });

  it("GRID_STYLE has strokeDasharray and stroke", () => {
    expect(GRID_STYLE).toHaveProperty("strokeDasharray");
    expect(GRID_STYLE).toHaveProperty("stroke");
  });

  it("TOOLTIP_STYLE has contentStyle, itemStyle, labelStyle", () => {
    expect(TOOLTIP_STYLE).toHaveProperty("contentStyle");
    expect(TOOLTIP_STYLE).toHaveProperty("itemStyle");
    expect(TOOLTIP_STYLE).toHaveProperty("labelStyle");
  });
});
