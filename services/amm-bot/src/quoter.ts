// ---------------------------------------------------------------------------
// Quote Generator — Bid/Ask with spread and inventory skew
//
// Generates two-sided quotes around a fair value, adjusting for current
// inventory position to manage risk. When the bot is long, it shades quotes
// down to encourage selling; when short, it shades up to encourage buying.
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

export interface Quote {
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
 * @param fairPrice  Fair value probability in [0.01, 0.99]
 * @param inventory  Current net inventory (positive = long, negative = short)
 * @param config     Quote configuration parameters
 * @returns          Bid and ask prices in cents, plus diagnostics
 */
export function generateQuotes(
  fairPrice: number,
  inventory: number,
  config: QuoteConfig = DEFAULT_CONFIG,
): Quote {
  // Half-spread in probability units
  const halfSpread = (fairPrice * config.spreadBps) / 10_000;

  // Inventory skew: shifts both bid and ask in the same direction
  //   Positive inventory (long) → negative skew → lower bid, lower ask (try to sell)
  //   Negative inventory (short) → positive skew → raise bid, raise ask (try to buy)
  const skew =
    (inventory / config.maxInventory) * config.skewFactor * halfSpread;

  let bidPrice = Math.max(
    1,
    Math.round(fairPrice * 100 - halfSpread * 100 - skew * 100),
  );
  let askPrice = Math.min(
    99,
    Math.round(fairPrice * 100 + halfSpread * 100 - skew * 100),
  );

  // Ensure bid < ask with at least minEdge gap
  if (bidPrice >= askPrice) {
    const mid = Math.round((bidPrice + askPrice) / 2);
    bidPrice = Math.max(1, mid - config.minEdge);
    askPrice = Math.min(99, mid + config.minEdge);
    // If still crossed (extreme edge), force apart
    if (bidPrice >= askPrice) {
      bidPrice = Math.max(1, askPrice - config.minEdge);
    }
  }

  return { bidPrice, askPrice, fairPrice, skew };
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Determine whether the bot should halt quoting.
 *
 * @param inventory          Current net inventory
 * @param maxInventory       Maximum allowed inventory
 * @param consecutiveErrors  Number of consecutive on-chain errors
 * @returns                  true if the bot should stop quoting
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
