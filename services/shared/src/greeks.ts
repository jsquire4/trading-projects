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

import { normalCdf, normalPdf } from './pricer';
export { normalCdf, normalPdf };

/** Black-Scholes d2: d2 = [ln(S/K) + (r - σ²/2) · T] / (σ · √T) */
export function d2(
  S: number,
  K: number,
  sigma: number,
  T: number,
  r: number = 0.05,
): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return NaN;
  const sqrtT = Math.sqrt(T);
  return (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
}

/**
 * Binary (cash-or-nothing) call delta.
 *
 * Δ = e^(-rT) · N'(d2) / (S · σ · √T)
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
  return Math.exp(-r * T) * normalPdf(d2Val) / (S * sigma * sqrtT);
}

/**
 * Binary (cash-or-nothing) call gamma.
 *
 * Γ = dΔ/dS  (analytical derivative of binaryDelta with respect to S)
 *
 * Derived by differentiating Δ = e^(-rT) · N'(d2) / (S σ √T) where d2 is a function of S:
 *   Γ = -e^(-rT) · N'(d2) / (S² σ √T) · [1 + d2 / (σ √T)]
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
  return Math.exp(-r * T) * (-pdf / (S * S * sigma * sqrtT)) * (1 + d2Val / (sigma * sqrtT));
}

/**
 * Binary (cash-or-nothing) call theta.
 *
 * Theta = dC/dT where C = e^(-rT) N(d2)
 *
 * Theta = -r e^(-rT) N(d2) + e^(-rT) n(d2) dd2/dT
 *
 * where dd2/dT = -d2/(2T) + (r - σ²/2) / (σ √T)
 */
export function binaryTheta(
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
  const cdf = normalCdf(d2Val);
  const disc = Math.exp(-r * T);
  const dd2dT = -d2Val / (2 * T) + (r - 0.5 * sigma * sigma) / (sigma * sqrtT);
  return -r * disc * cdf + disc * pdf * dd2dT;
}

/**
 * Binary (cash-or-nothing) call vega.
 *
 * Vega = dC/dσ where C = e^(-rT) N(d2)
 *
 * Vega = e^(-rT) n(d2) dd2/dσ
 *
 * where dd2/dσ = -d2/σ - √T
 */
export function binaryVega(
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
  const disc = Math.exp(-r * T);
  const dd2dSigma = -d2Val / sigma - sqrtT;
  return disc * pdf * dd2dSigma;
}
