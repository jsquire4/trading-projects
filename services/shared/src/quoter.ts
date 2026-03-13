// ---------------------------------------------------------------------------
// Quote Generator — Bid/Ask with spread and inventory skew
//
// Canonical shared implementation. Generates two-sided quotes around a fair
// value, adjusting for current inventory position.
//
// NOTE: The AMM bot has its own wrapper around generateQuotes that adds a
// halfSpread floor (Math.max(rawHalfSpread, 0.005)) to prevent zero-width
// quotes at extreme fair prices. This shared version has no floor.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuoteConfig {
  /** Half-spread in basis points of fair price. Default 500 = 5%. */
  spreadBps: number;
  /** Maximum inventory (in pairs) before circuit breaker halts. Default 1000. */
  maxInventory: number;
  /** Skew aggressiveness factor (0 = no skew, 1 = full skew). Default 0.5. */
  skewFactor: number;
  /** Minimum edge in price-cents (ensures bid < ask). Default 1 (= 1 cent). */
  minEdge: number;
}

export interface QuoteResult {
  /** Bid price in cents [1, 99] */
  bidPrice: number;
  /** Ask price in cents [1, 99] */
  askPrice: number;
  /** Fair value probability used for pricing */
  fairPrice: number;
  /** Applied inventory skew (in probability units) */
  skew: number;
}

export const DEFAULT_CONFIG: QuoteConfig = {
  spreadBps: 500,
  maxInventory: 1000,
  skewFactor: 0.5,
  minEdge: 1,
};

// ---------------------------------------------------------------------------
// Quote generation
// ---------------------------------------------------------------------------

/**
 * Generate a two-sided quote (bid/ask) around a fair value.
 *
 * Inventory skew shifts the midpoint:
 *   - Positive inventory (long) → negative skew → encourages selling
 *   - Negative inventory (short) → positive skew → encourages buying
 *
 * @param fairPrice  Fair value probability in [0, 1]
 * @param inventory  Current net inventory (positive = long, negative = short)
 * @param config     Quote configuration parameters
 */
export function generateQuotes(
  fairPrice: number,
  inventory: number,
  config: QuoteConfig = DEFAULT_CONFIG,
): QuoteResult {
  // Half-spread in probability units
  const halfSpread = (fairPrice * config.spreadBps) / 10_000;

  // Inventory skew: positive inventory → negative skew (shift quotes down)
  const skew =
    -(inventory / config.maxInventory) * config.skewFactor * halfSpread;

  let bidPrice = Math.max(
    1,
    Math.round(fairPrice * 100 - halfSpread * 100 + skew * 100),
  );
  let askPrice = Math.min(
    99,
    Math.round(fairPrice * 100 + halfSpread * 100 + skew * 100),
  );

  // Ensure bid < ask with at least minEdge gap
  if (bidPrice >= askPrice) {
    const mid = Math.round((bidPrice + askPrice) / 2);
    bidPrice = Math.max(1, mid - config.minEdge);
    askPrice = Math.min(99, mid + config.minEdge);
    if (bidPrice >= askPrice) {
      askPrice = Math.min(99, bidPrice + config.minEdge + 1);
      if (bidPrice >= askPrice) {
        bidPrice = Math.max(1, askPrice - config.minEdge - 1);
      }
    }
  }

  return { bidPrice, askPrice, fairPrice, skew };
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Determine whether quoting should halt.
 *
 * @param inventory          Current net inventory
 * @param maxInventory       Maximum allowed inventory
 * @param consecutiveErrors  Number of consecutive on-chain errors
 * @returns                  true if quoting should stop
 */
export function shouldHalt(
  inventory: number,
  maxInventory: number,
  consecutiveErrors: number,
): boolean {
  if (Math.abs(inventory) > maxInventory) return true;
  if (consecutiveErrors > 5) return true;
  return false;
}
