import { describe, it, expect } from "vitest";
import { generateStrikes, roundToNearest } from "../strikes";

describe("roundToNearest", () => {
  it("rounds down when below midpoint", () => {
    expect(roundToNearest(104, 10)).toBe(100);
  });

  it("rounds up when at or above midpoint", () => {
    expect(roundToNearest(105, 10)).toBe(110);
  });

  it("returns exact value when already a multiple", () => {
    expect(roundToNearest(200, 10)).toBe(200);
  });
});

describe("generateStrikes", () => {
  it("generates correct strikes at +/-3/6/9% from previous close", () => {
    // previousClose = $500
    // -9%: 455 → round to 460
    // -6%: 470 → 470
    // -3%: 485 → 490
    // +3%: 515 → 520
    // +6%: 530 → 530
    // +9%: 545 → 550
    const result = generateStrikes(500);
    expect(result.previousClose).toBe(500);
    expect(result.strikes).toEqual([460, 470, 490, 520, 530, 550]);
  });

  it("rounds to nearest $10", () => {
    const result = generateStrikes(500);
    for (const strike of result.strikes) {
      expect(strike % 10).toBe(0);
    }
  });

  it("deduplicates strikes", () => {
    // For a low price where multiple offsets round to the same value
    // previousClose = $100
    // -9%: 91 → 90
    // -6%: 94 → 90  (duplicate!)
    // -3%: 97 → 100
    // +3%: 103 → 100 (duplicate!)
    // +6%: 106 → 110
    // +9%: 109 → 110 (duplicate!)
    const result = generateStrikes(100);
    const hasDuplicates = result.strikes.length !== new Set(result.strikes).size;
    expect(hasDuplicates).toBe(false);
  });

  it("returns strikes sorted ascending", () => {
    const result = generateStrikes(300);
    for (let i = 1; i < result.strikes.length; i++) {
      expect(result.strikes[i]).toBeGreaterThan(result.strikes[i - 1]);
    }
  });

  it("works with large prices", () => {
    const result = generateStrikes(5000);
    expect(result.strikes.length).toBeGreaterThan(0);
    expect(result.strikes.every((s) => s % 10 === 0)).toBe(true);
  });
});
