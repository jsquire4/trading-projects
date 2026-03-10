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
 * Standard normal CDF using the Abramowitz & Stegun rational approximation.
 * Maximum absolute error: ~7.5e-8.
 */
export function normalCdf(x: number): number {
  if (x < -10) return 0;
  if (x > 10) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const y = 1.0 - poly * Math.exp(-0.5 * absX * absX);

  return 0.5 * (1.0 + sign * y);
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
  if (K <= 0) return 0.01;
  if (S <= 0) return 0.01;
  if (T <= 0) return S >= K ? 0.99 : 0.01;
  if (sigma <= 0) return S >= K ? 0.99 : 0.01;

  const d2 =
    (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));

  const prob = Math.exp(-r * T) * normalCdf(d2);

  // Clamp to [0.01, 0.99]
  return Math.max(0.01, Math.min(0.99, prob));
}

/**
 * Convert a probability (0.01–0.99) to a price in cents (1–99),
 * suitable for the on-chain order book which uses u8 prices.
 */
export function probToCents(prob: number): number {
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}
