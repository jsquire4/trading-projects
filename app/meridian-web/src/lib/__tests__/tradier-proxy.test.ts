import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set env var before importing the module
process.env.TRADIER_API_KEY = "test-key";

// We need to re-import after each test to reset the module-level cache.
// Use dynamic imports to work around module caching.

import { getTodayExpiration } from "../tradier-proxy";

// ---------------------------------------------------------------------------
// getTodayExpiration
// ---------------------------------------------------------------------------

describe("getTodayExpiration", () => {
  it("returns a string matching YYYY-MM-DD format", () => {
    const result = getTodayExpiration();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a plausible date (not in the distant past or future)", () => {
    const result = getTodayExpiration();
    const date = new Date(result);
    const now = new Date();
    // Should be within 2 days of current UTC date (timezone differences)
    const diffMs = Math.abs(now.getTime() - date.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Caching behavior with mocked fetch
// ---------------------------------------------------------------------------

describe("tradier-proxy caching", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;

    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    // Clear the module's internal cache by resetting modules
    vi.resetModules();
  });

  describe("getQuotes caching", () => {
    it("caches results and does not re-fetch within TTL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          quotes: {
            quote: [
              {
                symbol: "AAPL",
                last: 185,
                bid: 184.9,
                ask: 185.1,
                prevclose: 184,
                volume: 1000000,
                change: 1,
                change_percentage: 0.54,
              },
            ],
          },
        }),
      });

      // Dynamic import to get fresh module with our mocked fetch
      const { getQuotes } = await import("../tradier-proxy");

      // First call should hit fetch
      const result1 = await getQuotes(["AAPL"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result1).toHaveLength(1);
      expect(result1[0].symbol).toBe("AAPL");
      expect(result1[0].last).toBe(185);

      // Second immediate call should use cache
      const result2 = await getQuotes(["AAPL"]);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1 — no new fetch
      expect(result2).toEqual(result1);
    });

    it("re-fetches after TTL expires (60s)", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          quotes: {
            quote: {
              symbol: "MSFT",
              last: 400,
              bid: 399,
              ask: 401,
              prevclose: 398,
              volume: 500000,
              change: 2,
              change_percentage: 0.5,
            },
          },
        }),
      });

      const { getQuotes } = await import("../tradier-proxy");

      await getQuotes(["MSFT"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time past the 60s TTL
      vi.advanceTimersByTime(61_000);

      await getQuotes(["MSFT"]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns empty array for empty symbols list", async () => {
      const { getQuotes } = await import("../tradier-proxy");
      const result = await getQuotes([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getHistory caching", () => {
    it("caches history results and reuses within TTL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          history: {
            day: [
              {
                date: "2025-01-02",
                open: 100,
                high: 105,
                low: 99,
                close: 103,
                volume: 50000,
              },
              {
                date: "2025-01-03",
                open: 103,
                high: 107,
                low: 102,
                close: 106,
                volume: 60000,
              },
            ],
          },
        }),
      });

      const { getHistory } = await import("../tradier-proxy");

      const result1 = await getHistory("AAPL", "2025-01-01", "2025-01-31");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result1).toHaveLength(2);
      expect(result1[0].date).toBe("2025-01-02");

      // Cached call
      const result2 = await getHistory("AAPL", "2025-01-01", "2025-01-31");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result2).toEqual(result1);
    });

    it("re-fetches history after TTL expires", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          history: {
            day: {
              date: "2025-01-02",
              open: 100,
              high: 105,
              low: 99,
              close: 103,
              volume: 50000,
            },
          },
        }),
      });

      const { getHistory } = await import("../tradier-proxy");

      await getHistory("TSLA");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);

      await getHistory("TSLA");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("getOptionsChain caching", () => {
    it("caches options chain results and reuses within TTL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          options: {
            option: [
              {
                symbol: "AAPL250117C00185000",
                description: "AAPL Jan 17 2025 185 Call",
                type: "option",
                last: 5.2,
                bid: 5.1,
                ask: 5.3,
                strike: 185,
                option_type: "call",
                expiration_date: "2025-01-17",
                open_interest: 1000,
                volume: 500,
                greeks: {
                  delta: 0.55,
                  gamma: 0.03,
                  theta: -0.05,
                  vega: 0.15,
                  rho: 0.01,
                  phi: -0.01,
                  bid_iv: 0.28,
                  mid_iv: 0.29,
                  ask_iv: 0.3,
                  smv_vol: 0.285,
                },
              },
            ],
          },
        }),
      });

      const { getOptionsChain } = await import("../tradier-proxy");

      const result1 = await getOptionsChain("AAPL", "2025-01-17");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result1).toHaveLength(1);
      expect(result1[0].strike).toBe(185);
      expect(result1[0].greeks?.delta).toBe(0.55);

      // Cached call
      const result2 = await getOptionsChain("AAPL", "2025-01-17");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result2).toEqual(result1);
    });

    it("re-fetches options chain after TTL expires", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          options: {
            option: [],
          },
        }),
      });

      const { getOptionsChain } = await import("../tradier-proxy");

      await getOptionsChain("AAPL", "2025-01-17");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);

      await getOptionsChain("AAPL", "2025-01-17");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetch error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const { getQuotes } = await import("../tradier-proxy");

      await expect(getQuotes(["AAPL"])).rejects.toThrow("Tradier API 401");
    });
  });
});
