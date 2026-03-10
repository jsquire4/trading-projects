/**
 * Binary option greeks — pure math, no external dependencies.
 *
 * Conventions:
 *   S     spot price (dollars)
 *   K     strike price (dollars)
 *   sigma annual volatility (decimal, e.g. 0.30 = 30%)
 *   T     time to expiry in years
 *   r     continuous risk-free rate (default 0.05)
 */

/** Standard normal probability density function. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution function.
 * Uses the Abramowitz & Stegun rational approximation (eqn 26.2.17)
 * which is accurate to ~1.5 × 10⁻⁷.
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const y = 1 - poly * Math.exp(-0.5 * absX * absX);

  return 0.5 * (1 + sign * y);
}

/** Black-Scholes d2: d2 = [ln(S/K) + (r - σ²/2) · T] / (σ · √T) */
export function d2(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  const sqrtT = Math.sqrt(T);
  return (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
}

/**
 * Binary (cash-or-nothing) call delta.
 *
 * Δ = N'(d2) / (S · σ · √T)
 *
 * Measures the sensitivity of the binary call price to a change in spot.
 */
export function binaryDelta(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d2Val = d2(S, K, sigma, T, r);
  return normalPdf(d2Val) / (S * sigma * sqrtT);
}

/**
 * Binary (cash-or-nothing) call gamma.
 *
 * Γ = dΔ/dS  (analytical derivative of binaryDelta with respect to S)
 *
 * Derived by differentiating Δ = N'(d2) / (S σ √T) where d2 is a function of S:
 *   Γ = -N'(d2) / (S² σ √T) · [1 + d2 / (σ √T)]
 */
export function binaryGamma(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d2Val = d2(S, K, sigma, T, r);
  const pdf = normalPdf(d2Val);
  return (-pdf / (S * S * sigma * sqrtT)) * (1 + d2Val / (sigma * sqrtT));
}
