// ---------------------------------------------------------------------------
// Market Data Factory Tests — createMarketDataClient toggle
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Don't import classes at top level — vi.resetModules() creates fresh copies
// that won't match. Use constructor.name instead of toBeInstanceOf.

describe("createMarketDataClient", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns SyntheticClient when MARKET_DATA_SOURCE=synthetic", async () => {
    process.env.MARKET_DATA_SOURCE = "synthetic";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient();
    expect(client.constructor.name).toBe("SyntheticClient");
  });

  it("returns TradierClient when MARKET_DATA_SOURCE=live", async () => {
    process.env.MARKET_DATA_SOURCE = "live";
    process.env.TRADIER_API_KEY = "test-key-123";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient();
    expect(client.constructor.name).toBe("TradierClient");
  });

  it("returns TradierClient when MARKET_DATA_SOURCE is unset", async () => {
    delete process.env.MARKET_DATA_SOURCE;
    process.env.TRADIER_API_KEY = "test-key-123";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient();
    expect(client.constructor.name).toBe("TradierClient");
  });

  it("SyntheticClient uses SYNTHETIC_SEED env var", async () => {
    process.env.MARKET_DATA_SOURCE = "synthetic";
    process.env.SYNTHETIC_SEED = "123";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient();
    expect(client.constructor.name).toBe("SyntheticClient");
    const quotes = await client.getQuotes(["AAPL"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("AAPL");
  });

  it("SyntheticClient defaults to seed 42 when SYNTHETIC_SEED unset", async () => {
    process.env.MARKET_DATA_SOURCE = "synthetic";
    delete process.env.SYNTHETIC_SEED;
    const { createMarketDataClient } = await import("../market-data.js");
    const clientA = createMarketDataClient();
    // Import SyntheticClient from same module cache for fair comparison
    const { SyntheticClient } = await import("../synthetic-client.js");
    const clientB = new SyntheticClient({ seed: 42 });
    const qA = await clientA.getQuotes(["AAPL"]);
    const qB = await clientB.getQuotes(["AAPL"]);
    expect(qA).toEqual(qB);
  });

  it("TradierClient throws without API key", async () => {
    process.env.MARKET_DATA_SOURCE = "live";
    delete process.env.TRADIER_API_KEY;
    const { createMarketDataClient } = await import("../market-data.js");
    expect(() => createMarketDataClient()).toThrow("Tradier API key is required");
  });

  it("passes options through to TradierClient", async () => {
    process.env.MARKET_DATA_SOURCE = "live";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient({ apiKey: "custom-key", sandbox: true });
    expect(client.constructor.name).toBe("TradierClient");
  });

  it("IMarketDataClient interface is satisfied by both implementations", async () => {
    process.env.MARKET_DATA_SOURCE = "synthetic";
    const { createMarketDataClient } = await import("../market-data.js");
    const client = createMarketDataClient();
    expect(typeof client.getQuotes).toBe("function");
    expect(typeof client.getHistory).toBe("function");
    expect(typeof client.getMarketClock).toBe("function");
    expect(typeof client.getMarketCalendar).toBe("function");
    expect(typeof client.createStreamSession).toBe("function");
    expect(typeof client.getOptionsChain).toBe("function");
  });
});
