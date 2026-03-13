// ---------------------------------------------------------------------------
// Binary Option Pricer — Black-Scholes N(d2)
//
// Prices binary (digital) call options using the standard formula:
//   P = e^(-rT) * N(d2)
// where d2 = [ln(S/K) + (r - sigma^2/2) * T] / (sigma * sqrt(T))
//
// Uses the Abramowitz & Stegun polynomial approximation for the standard
// normal CDF, matching the implementation in app/meridian-web/src/lib/greeks.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Normal distribution helpers
// ---------------------------------------------------------------------------

/** Standard normal PDF: (1/sqrt(2pi)) * e^(-x^2/2) */
export function normalPdf(x: number): number {
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
  if (x <= -8) return 0;
  if (x >= 8) return 1;

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
 * @param S     Current underlying price (e.g. dollars)
 * @param K     Strike price (same units as S)
 * @param sigma Annualized implied/historical volatility (e.g. 0.30 = 30%)
 * @param T     Time to expiry in years (e.g. 6.5 hours = 6.5/8760)
 * @param r     Risk-free rate (annualized, e.g. 0.05 = 5%). Default 0.05.
 * @returns     Probability in [0.01, 0.99]
 */
export function binaryCallPrice(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  // Edge cases
  if (K <= 0 || S <= 0) return 0.0;
  if (T <= 0 || sigma <= 0) return S >= K ? 1.0 : 0.0;

  const d2 =
    (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));

  const prob = Math.exp(-r * T) * normalCdf(d2);

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, prob));
}

/**
 * Convert a probability (0.01–0.99) to a price in cents (1–99),
 * suitable for the on-chain order book which uses u8 prices.
 */
export function probToCents(prob: number): number {
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}
