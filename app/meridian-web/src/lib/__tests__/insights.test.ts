import { describe, it, expect } from "vitest";
import {
  interpretDelta,
  interpretGamma,
  interpretSpread,
  interpretOrderDepth,
  interpretPosition,
  interpretReturnDistribution,
  type Insight,
  type DepthLevel,
} from "../insights";

describe("interpretDelta", () => {
  it("high delta (0.85) → bullish, mentions likely/high probability", () => {
    const result = interpretDelta(0.85, "AAPL", 180);
    expect(result.sentiment).toBe("bullish");
    expect(result.text.toLowerCase()).toMatch(/likely|high probability/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("low delta (0.15) → bearish, mentions unlikely/low probability", () => {
    const result = interpretDelta(0.15, "TSLA", 250);
    expect(result.sentiment).toBe("bearish");
    expect(result.text.toLowerCase()).toMatch(/unlikely|low probability/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("mid delta (0.50) → neutral, mentions coin flip/even odds", () => {
    const result = interpretDelta(0.5, "SPY", 450);
    expect(result.sentiment).toBe("neutral");
    expect(result.text.toLowerCase()).toMatch(/coin flip|even odds/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("includes ticker and strike in text", () => {
    const result = interpretDelta(0.85, "AAPL", 180);
    expect(result.text).toContain("AAPL");
    expect(result.text).toContain("180");
  });
});

describe("interpretGamma", () => {
  it("high gamma (>0.02) → high urgency, mentions volatile/sensitive", () => {
    const result = interpretGamma(0.03, "AAPL");
    expect(result.urgency).toBe("high");
    expect(result.text.toLowerCase()).toMatch(/volatile|sensitive/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("low gamma (<0.005) → low urgency, mentions stable/settled", () => {
    const result = interpretGamma(0.003, "TSLA");
    expect(result.urgency).toBe("low");
    expect(result.text.toLowerCase()).toMatch(/stable|settled/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });
});

describe("interpretSpread", () => {
  it("tight spread (1-2 cents) → mentions liquid/tight", () => {
    const result = interpretSpread(1.5);
    expect(result.text.toLowerCase()).toMatch(/liquid|tight/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("wide spread (>10 cents) → medium urgency, mentions illiquid/wide", () => {
    const result = interpretSpread(15);
    expect(result.text.toLowerCase()).toMatch(/illiquid|wide/);
    expect(result.urgency).toBe("medium");
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("zero spread → mentions locked/no spread", () => {
    const result = interpretSpread(0);
    expect(result.text.toLowerCase()).toMatch(/locked|no spread/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });
});

describe("interpretOrderDepth", () => {
  const heavyBids: DepthLevel[] = [
    { price: 0.55, quantity: 500 },
    { price: 0.54, quantity: 300 },
  ];
  const lightAsks: DepthLevel[] = [{ price: 0.56, quantity: 50 }];

  const lightBids: DepthLevel[] = [{ price: 0.45, quantity: 40 }];
  const heavyAsks: DepthLevel[] = [
    { price: 0.46, quantity: 400 },
    { price: 0.47, quantity: 350 },
  ];

  const balancedBids: DepthLevel[] = [{ price: 0.5, quantity: 200 }];
  const balancedAsks: DepthLevel[] = [{ price: 0.51, quantity: 200 }];

  it("heavy bid side → bullish, mentions buying pressure", () => {
    const result = interpretOrderDepth(heavyBids, lightAsks);
    expect(result.sentiment).toBe("bullish");
    expect(result.text.toLowerCase()).toMatch(/buying pressure/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("heavy ask side → bearish, mentions selling pressure", () => {
    const result = interpretOrderDepth(lightBids, heavyAsks);
    expect(result.sentiment).toBe("bearish");
    expect(result.text.toLowerCase()).toMatch(/selling pressure/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("balanced depth → neutral", () => {
    const result = interpretOrderDepth(balancedBids, balancedAsks);
    expect(result.sentiment).toBe("neutral");
    expect(result.text.length).toBeLessThanOrEqual(100);
  });
});

describe("interpretPosition", () => {
  it("winning position with time left → suggests hold/lock in", () => {
    const result = interpretPosition("Yes", 50, 30);
    expect(result.text.toLowerCase()).toMatch(/hold|lock in/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("losing position near expiry → high urgency", () => {
    const result = interpretPosition("Yes", -25, 3);
    expect(result.urgency).toBe("high");
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("winning position near expiry (<5 min) → mentions almost there", () => {
    const result = interpretPosition("Yes", 40, 3);
    expect(result.text.toLowerCase()).toMatch(/almost there/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });
});

describe("interpretReturnDistribution", () => {
  it("current move > 2 sigma → mentions unusual/outlier", () => {
    const result = interpretReturnDistribution(2.5, 1.0);
    expect(result.text.toLowerCase()).toMatch(/unusual|outlier/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("current move 1-2 sigma → mentions notable", () => {
    const result = interpretReturnDistribution(1.5, 1.0);
    expect(result.text.toLowerCase()).toMatch(/notable|broader/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("current move < 0.5 sigma → mentions normal/typical", () => {
    const result = interpretReturnDistribution(0.3, 1.0);
    expect(result.text.toLowerCase()).toMatch(/normal|typical/);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });
});
