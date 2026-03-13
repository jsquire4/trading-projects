// ---------------------------------------------------------------------------
// AMM Bot Quote Generator — wraps shared quoter with bot-specific behavior
//
// The shared quoter has no halfSpread floor. This wrapper adds a floor of
// 0.005 to prevent zero-width quotes at extreme fair prices, which matters
// for the AMM bot but not for the frontend display.
// ---------------------------------------------------------------------------

import {
  type QuoteConfig,
  DEFAULT_CONFIG,
  shouldHalt,
} from "../../shared/src/quoter.js";

export { DEFAULT_CONFIG, shouldHalt };
export type { QuoteConfig };

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

/**
 * Generate a two-sided quote (bid/ask) around a fair value.
 *
 * AMM-bot-specific: includes a halfSpread floor of 0.005 to prevent
 * zero-width quotes after rounding to integer cents at extreme fair prices.
 *
 * Skew convention: positive inventory → positive skew value, subtracted
 * from both bid and ask to shift quotes down (encourage selling).
 */
export function generateQuotes(
  fairPrice: number,
  inventory: number,
  config: QuoteConfig = DEFAULT_CONFIG,
): Quote {
  // Half-spread in probability units. Floor ensures at least 1 cent spread
  // when converted to cents: halfSpread * 100 >= 0.5 → rounds to at least 1c.
  const rawHalfSpread = (fairPrice * config.spreadBps) / 10_000;
  const halfSpread = Math.max(rawHalfSpread, 0.005);

  // Inventory skew: shifts both bid and ask in the same direction.
  //   Positive inventory (long) → positive skew → lower bid, lower ask (try to sell)
  //   Negative inventory (short) → negative skew → raise bid, raise ask (try to buy)
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
    if (bidPrice >= askPrice) {
      askPrice = Math.min(99, bidPrice + config.minEdge + 1);
      if (bidPrice >= askPrice) {
        bidPrice = Math.max(1, askPrice - config.minEdge - 1);
      }
    }
  }

  return { bidPrice, askPrice, fairPrice, skew };
}
