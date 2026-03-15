/**
 * Position valuation helpers shared across PnlTab and usePortfolioSnapshot.
 */

/**
 * Compute the estimated USDC value of a position given Yes/No balances
 * (in token units, already divided by 1e6) and a mid-price (0-1 scale).
 *
 * Value = yesBal * midPrice + noBal * (1 - midPrice)
 */
export function calcPositionValue(
  yesBal: number,
  noBal: number,
  midPrice: number,
): number {
  return yesBal * midPrice + noBal * (1 - midPrice);
}
