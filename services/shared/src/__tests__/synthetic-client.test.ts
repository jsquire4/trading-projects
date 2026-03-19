// ---------------------------------------------------------------------------
// SyntheticClient Tests — interface contract, determinism, edge cases
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { SyntheticClient } from "../synthetic-client";
import { BASE_PRICES, DEFAULT_PRICE } from "../synthetic-config";

function makeClient(seed = 42) {
  return new SyntheticClient({ seed });
}

// ---- getQuotes --------------------------------------------------------------

describe("SyntheticClient.getQuotes", () => {
  it("returns empty array for empty symbols", async () => {
    const client = makeClient();
    expect(await client.getQuotes([])).toEqual([]);
  });

  it("returns one Quote per symbol", async () => {
    const client = makeClient();
    const quotes = await client.getQuotes(["AAPL", "TSLA"]);
    expect(quotes).toHaveLength(2);
    expect(quotes[0].symbol).toBe("AAPL");
    expect(quotes[1].symbol).toBe("TSLA");
  });

  it("Quote has all required fields", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["AAPL"]);
    expect(q).toHaveProperty("symbol");
    expect(q).toHaveProperty("last");
    expect(q).toHaveProperty("bid");
    expect(q).toHaveProperty("ask");
    expect(q).toHaveProperty("prevclose");
    expect(q).toHaveProperty("volume");
    expect(q).toHaveProperty("change");
    expect(q).toHaveProperty("change_percentage");
  });

  it("bid < last < ask (spread)", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["AAPL"]);
    expect(q.bid).toBeLessThan(q.last);
    expect(q.ask).toBeGreaterThan(q.last);
  });

  it("prevclose matches base price", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["AAPL"]);
    expect(q.prevclose).toBe(BASE_PRICES["AAPL"]);
  });

  it("unknown ticker uses DEFAULT_PRICE", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["ZZZZ"]);
    expect(q.prevclose).toBe(DEFAULT_PRICE);
  });

  it("same seed produces same quotes", async () => {
    const a = makeClient(42);
    const b = makeClient(42);
    const qa = await a.getQuotes(["AAPL"]);
    const qb = await b.getQuotes(["AAPL"]);
    expect(qa).toEqual(qb);
  });

  it("different seeds produce different quotes", async () => {
    const a = makeClient(42);
    const b = makeClient(99);
    const qa = await a.getQuotes(["AAPL"]);
    const qb = await b.getQuotes(["AAPL"]);
    expect(qa[0].last).not.toBe(qb[0].last);
  });

  it("prices evolve on successive calls", async () => {
    const client = makeClient();
    const [q1] = await client.getQuotes(["AAPL"]);
    const [q2] = await client.getQuotes(["AAPL"]);
    // Different calls should produce different prices (GBM evolution)
    expect(q1.last).not.toBe(q2.last);
  });

  it("volume is a positive integer", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["AAPL"]);
    expect(q.volume).toBeGreaterThan(0);
    expect(Number.isInteger(q.volume)).toBe(true);
  });

  it("change and change_percentage are consistent", async () => {
    const client = makeClient();
    const [q] = await client.getQuotes(["AAPL"]);
    const expectedChange = Math.round((q.last - q.prevclose!) * 100) / 100;
    expect(q.change).toBe(expectedChange);
  });
});

// ---- getHistory -------------------------------------------------------------

describe("SyntheticClient.getHistory", () => {
  it("returns bars with all OHLCV fields", async () => {
    const client = makeClient();
    const bars = await client.getHistory("AAPL");
    expect(bars.length).toBeGreaterThan(0);
    const bar = bars[0];
    expect(bar).toHaveProperty("date");
    expect(bar).toHaveProperty("open");
    expect(bar).toHaveProperty("high");
    expect(bar).toHaveProperty("low");
    expect(bar).toHaveProperty("close");
    expect(bar).toHaveProperty("volume");
  });

  it("returns 90 bars by default", async () => {
    const client = makeClient();
    const bars = await client.getHistory("AAPL");
    expect(bars).toHaveLength(90);
  });

  it("is deterministic for same seed and symbol", async () => {
    const a = makeClient(42);
    const b = makeClient(42);
    const barsA = await a.getHistory("AAPL");
    const barsB = await b.getHistory("AAPL");
    expect(barsA).toEqual(barsB);
  });

  it("filters by end date", async () => {
    const client = makeClient();
    const allBars = await client.getHistory("AAPL");
    const midDate = allBars[Math.floor(allBars.length / 2)].date;
    const filtered = await client.getHistory("AAPL", undefined, undefined, midDate);
    expect(filtered.length).toBeLessThan(allBars.length);
    for (const bar of filtered) {
      expect(bar.date <= midDate).toBe(true);
    }
  });

  it("different symbols produce different bars", async () => {
    const client = makeClient();
    const aaplBars = await client.getHistory("AAPL");
    const tslaBars = await client.getHistory("TSLA");
    expect(aaplBars[0].open).not.toBe(tslaBars[0].open);
  });
});

// ---- getMarketClock ---------------------------------------------------------

describe("SyntheticClient.getMarketClock", () => {
  it("returns a valid market state based on current ET time", async () => {
    const client = makeClient();
    const clock = await client.getMarketClock();
    expect(["premarket", "open", "postmarket", "closed"]).toContain(clock.state);
  });

  it("has all required fields", async () => {
    const client = makeClient();
    const clock = await client.getMarketClock();
    expect(clock).toHaveProperty("date");
    expect(clock).toHaveProperty("description");
    expect(clock).toHaveProperty("state");
    expect(clock).toHaveProperty("timestamp");
    expect(clock).toHaveProperty("next_change");
    expect(clock).toHaveProperty("next_state");
  });
});

// ---- getMarketCalendar ------------------------------------------------------

describe("SyntheticClient.getMarketCalendar", () => {
  it("returns only weekdays", async () => {
    const client = makeClient();
    const days = await client.getMarketCalendar(1, 2026);
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      // Parse with midday offset to avoid UTC/local timezone day shift
      const d = new Date(day.date + "T12:00:00");
      expect(d.getDay()).not.toBe(0);
      expect(d.getDay()).not.toBe(6);
    }
  });

  it("all days have status 'open'", async () => {
    const client = makeClient();
    const days = await client.getMarketCalendar(3, 2026);
    for (const day of days) {
      expect(day.status).toBe("open");
    }
  });

  it("each day has premarket, open, postmarket sessions", async () => {
    const client = makeClient();
    const days = await client.getMarketCalendar(3, 2026);
    for (const day of days) {
      expect(day.premarket).toHaveProperty("start");
      expect(day.premarket).toHaveProperty("end");
      expect(day.open).toHaveProperty("start");
      expect(day.open).toHaveProperty("end");
      expect(day.postmarket).toHaveProperty("start");
      expect(day.postmarket).toHaveProperty("end");
    }
  });

  it("uses current month/year when not specified", async () => {
    const client = makeClient();
    const days = await client.getMarketCalendar();
    expect(days.length).toBeGreaterThan(0);
  });
});

// ---- createStreamSession ----------------------------------------------------

describe("SyntheticClient.createStreamSession", () => {
  it("returns a string starting with 'synthetic-session-'", async () => {
    const client = makeClient();
    const session = await client.createStreamSession();
    expect(session).toMatch(/^synthetic-session-\d+$/);
  });
});

// ---- getOptionsChain --------------------------------------------------------

describe("SyntheticClient.getOptionsChain", () => {
  // Use a future expiration so T > 0
  const futureExpiry = "2027-01-15";

  it("returns both calls and puts", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry);
    const calls = chain.filter((o) => o.option_type === "call");
    const puts = chain.filter((o) => o.option_type === "put");
    expect(calls.length).toBeGreaterThan(0);
    expect(puts.length).toBeGreaterThan(0);
    expect(calls.length).toBe(puts.length);
  });

  it("each item has required fields", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry);
    const item = chain[0];
    expect(item).toHaveProperty("symbol");
    expect(item).toHaveProperty("strike");
    expect(item).toHaveProperty("option_type");
    expect(item).toHaveProperty("bid");
    expect(item).toHaveProperty("ask");
    expect(item).toHaveProperty("last");
    expect(item).toHaveProperty("underlying");
    expect(item).toHaveProperty("expiration_date");
    expect(item.underlying).toBe("AAPL");
    expect(item.expiration_date).toBe(futureExpiry);
  });

  it("bid <= last <= ask for each item", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry);
    for (const item of chain) {
      if (item.last !== null) {
        expect(item.bid).toBeLessThanOrEqual(item.last);
        expect(item.ask).toBeGreaterThanOrEqual(item.last);
      }
    }
  });

  it("includes greeks when requested", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry, true);
    const withGreeks = chain.filter((o) => o.greeks !== undefined);
    expect(withGreeks.length).toBe(chain.length);
    const g = withGreeks[0].greeks!;
    expect(g).toHaveProperty("delta");
    expect(g).toHaveProperty("gamma");
    expect(g).toHaveProperty("theta");
    expect(g).toHaveProperty("vega");
    expect(g).toHaveProperty("bid_iv");
    expect(g).toHaveProperty("mid_iv");
    expect(g).toHaveProperty("ask_iv");
  });

  it("omits greeks when not requested", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry, false);
    for (const item of chain) {
      expect(item.greeks).toBeUndefined();
    }
  });

  it("call delta is positive, put delta is negative", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry, true);
    const calls = chain.filter((o) => o.option_type === "call" && o.greeks);
    const puts = chain.filter((o) => o.option_type === "put" && o.greeks);
    for (const c of calls) {
      expect(c.greeks!.delta).toBeGreaterThanOrEqual(0);
    }
    for (const p of puts) {
      expect(p.greeks!.delta).toBeLessThanOrEqual(0);
    }
  });

  it("strikes are sorted around the spot price", async () => {
    const client = makeClient();
    const chain = await client.getOptionsChain("AAPL", futureExpiry);
    const strikes = [...new Set(chain.map((o) => o.strike))].sort((a, b) => a - b);
    const spot = BASE_PRICES["AAPL"];
    // At least one strike below and one above spot
    expect(strikes[0]).toBeLessThan(spot);
    expect(strikes[strikes.length - 1]).toBeGreaterThan(spot);
  });
});
