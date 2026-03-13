// ---------------------------------------------------------------------------
// Synthetic Market Data Configuration
//
// Base prices, default tickers, and seeded RNG for deterministic price
// generation. Shared between SyntheticClient and SyntheticProxy.
// ---------------------------------------------------------------------------

/** Realistic base prices for supported tickers (USD). */
export const BASE_PRICES: Record<string, number> = {
  AAPL: 190,
  TSLA: 250,
  AMZN: 185,
  MSFT: 420,
  NVDA: 130,
  GOOGL: 175,
  META: 500,
};

/** Default tickers used when no specific list is provided. */
export const DEFAULT_TICKERS = Object.keys(BASE_PRICES);

/** Default price for unknown tickers. */
export const DEFAULT_PRICE = 100;

/** Annual volatility for GBM simulation. */
export const DEFAULT_VOL = 0.30;

/** Annual drift (mu) for GBM simulation. */
export const DEFAULT_DRIFT = 0.0;

/**
 * Seeded pseudo-random number generator (LCG).
 *
 * Uses the Numerical Recipes LCG parameters for a simple, fast,
 * deterministic PRNG with no external dependencies.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number = 42) {
    // Ensure positive integer state
    this.state = (Math.abs(Math.floor(seed)) || 1) >>> 0;
  }

  /** Returns a value in [0, 1). */
  next(): number {
    // LCG: state = (a * state + c) mod m
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  /** Box-Muller transform: returns a standard normal sample. */
  nextGaussian(): number {
    const u1 = Math.max(1e-10, this.next()); // avoid log(0)
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/**
 * Hash a string to a numeric seed. Used to generate per-symbol
 * deterministic price sequences from a single global seed.
 */
export function hashSeed(globalSeed: number, symbol: string): number {
  let hash = globalSeed;
  for (let i = 0; i < symbol.length; i++) {
    hash = ((hash << 5) - hash + symbol.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

/**
 * Generate a single GBM price step.
 *
 * S_{t+dt} = S_t * exp((mu - sigma²/2)*dt + sigma*sqrt(dt)*Z)
 *
 * @param price  Current price
 * @param rng    Seeded RNG instance
 * @param sigma  Annual volatility (default 0.30)
 * @param dt     Time step in years (default 1/252 = one trading day)
 * @param mu     Annual drift (default 0.0)
 */
export function gbmStep(
  price: number,
  rng: SeededRng,
  sigma: number = DEFAULT_VOL,
  dt: number = 1 / 252,
  mu: number = DEFAULT_DRIFT,
): number {
  const z = rng.nextGaussian();
  return price * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
}

/**
 * Generate an array of OHLCV bars using GBM.
 *
 * @param basePrice   Starting price
 * @param numBars     Number of bars to generate
 * @param rng         Seeded RNG instance
 * @param startDate   Date of first bar (default: 90 trading days ago)
 * @param sigma       Annual volatility
 */
export function generateBars(
  basePrice: number,
  numBars: number,
  rng: SeededRng,
  startDate?: Date,
  sigma: number = DEFAULT_VOL,
): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  const bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  let price = basePrice;
  const start = startDate ?? new Date(Date.now() - numBars * 24 * 60 * 60 * 1000 * (7 / 5)); // rough trading day adjustment

  for (let i = 0; i < numBars; i++) {
    const open = price;
    // Simulate intraday with 4 sub-steps
    let high = open;
    let low = open;
    for (let j = 0; j < 4; j++) {
      price = gbmStep(price, rng, sigma, 1 / (252 * 4));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    const close = price;

    // Skip weekends
    const d = new Date(start);
    d.setDate(start.getDate() + Math.floor(i * 7 / 5) + i);
    while (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
    }

    const dateStr = d.toISOString().slice(0, 10);
    const volume = Math.floor(1_000_000 + rng.next() * 9_000_000);

    bars.push({
      date: dateStr,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });
  }

  return bars;
}
