import { describe, it, expect } from "vitest";
import { buildXShareUrl, buildLinkedInShareUrl, buildMarketDeepLink } from "../share";

describe("buildXShareUrl", () => {
  it("contains x.com/intent/tweet, ticker, side, and payout", () => {
    const url = buildXShareUrl("AAPL", "YES", 150);
    expect(url).toContain("x.com/intent/tweet");
    expect(url).toContain("AAPL");
    expect(url).toContain("YES");
    expect(url).toContain("%24150"); // "$150" encoded
  });

  it("encodes text properly for URL", () => {
    const url = buildXShareUrl("AAPL", "YES", 150);
    // Should not contain raw spaces or unencoded special chars in the query value
    const queryPart = url.split("?text=")[1];
    expect(queryPart).toBeDefined();
    // Encoded text should not contain raw spaces
    expect(queryPart).not.toContain(" ");
  });

  it("includes default hashtags", () => {
    const url = buildXShareUrl("AAPL", "YES", 150);
    expect(url).toContain("Meridian");
    expect(url).toContain("BinaryOptions");
  });

  it("produces a valid URL", () => {
    const url = buildXShareUrl("AAPL", "YES", 150);
    expect(() => new URL(url)).not.toThrow();
  });
});

describe("buildLinkedInShareUrl", () => {
  it("contains linkedin.com/sharing and the provided URL", () => {
    const url = buildLinkedInShareUrl("I won!", "https://meridian.app/trade/AAPL");
    expect(url).toContain("linkedin.com/sharing");
    expect(url).toContain(encodeURIComponent("https://meridian.app/trade/AAPL"));
  });

  it("encodes both text and URL", () => {
    const url = buildLinkedInShareUrl("I won big!", "https://meridian.app/trade/AAPL?strike=195");
    // The share URL should be properly encoded
    expect(url).toContain(encodeURIComponent("https://meridian.app/trade/AAPL?strike=195"));
    // Should be a valid URL
    expect(() => new URL(url)).not.toThrow();
  });

  it("produces a valid URL", () => {
    const url = buildLinkedInShareUrl("I won!", "https://meridian.app/trade/AAPL");
    expect(() => new URL(url)).not.toThrow();
  });
});

describe("buildMarketDeepLink", () => {
  it("returns /trade/{ticker} without strike", () => {
    expect(buildMarketDeepLink("AAPL")).toBe("/trade/AAPL");
  });

  it("returns /trade/{ticker}?strike={strike} with strike", () => {
    expect(buildMarketDeepLink("AAPL", 195)).toBe("/trade/AAPL?strike=195");
  });
});
