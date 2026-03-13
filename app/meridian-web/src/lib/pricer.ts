// ---------------------------------------------------------------------------
// Binary Option Pricer — Black-Scholes N(d2)
//
// Shared pricing library for the Meridian web app. Pure math, zero
// dependencies. Ported from services/amm-bot/src/pricer.ts and quoter.ts.
//
// Prices binary (digital) call options using the standard formula:
//   P = e^(-rT) * N(d2)
// where d2 = [ln(S/K) + (r - σ²/2) * T] / (σ * √T)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Normal distribution helpers
// ---------------------------------------------------------------------------

/** Standard normal PDF: (1/sqrt(2pi)) * e^(-x^2/2) */
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF using the Abramowitz & Stegun 26.2.17 approximation
 * in Horner form. Maximum absolute error: ~1.5e-7.
 *
 * Q(x) = n(x) * (b1*t + b2*t^2 + ... + b5*t^5) for x >= 0
 * Phi(x) = 1 - Q(x) for x >= 0, Q(-x) for x < 0
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const q = normalPdf(absX) * poly;

  return x >= 0 ? 1 - q : q;
}

// ---------------------------------------------------------------------------
// Binary call pricing
// ---------------------------------------------------------------------------

/**
 * Price a binary (digital) call option.
 *
 * Returns the probability that the underlying finishes above the strike,
 * discounted at the risk-free rate. Edge cases (T=0, σ=0) are handled
 * explicitly to avoid NaN / Infinity.
 *
 * @param S     Current underlying price (e.g. dollars)
 * @param K     Strike price (same units as S)
 * @param sigma Annualized implied/historical volatility (e.g. 0.20 = 20%)
 * @param T     Time to expiry in years (e.g. 6.5 hours = 6.5/8760)
 * @param r     Risk-free rate (annualized). Default 0.05.
 * @returns     Probability in [0, 1]
 */
export function binaryCallPrice(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  // Degenerate inputs
  if (K <= 0 || S <= 0) return 0.0;

  // At expiry or zero vol → binary payoff
  if (T <= 0 || sigma <= 0) {
    return S >= K ? 1.0 : 0.0;
  }

  const sqrtT = Math.sqrt(T);
  const d2 =
    (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);

  const prob = Math.exp(-r * T) * normalCdf(d2);

  return Math.max(0, Math.min(1, prob));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a probability [0, 1] to a price in cents [0, 100].
 */
export function probToCents(prob: number): number {
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}

// ---------------------------------------------------------------------------
// Quote generation
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

const DEFAULT_CONFIG: QuoteConfig = {
  spreadBps: 500,
  maxInventory: 1000,
  skewFactor: 0.5,
  minEdge: 1,
};

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
