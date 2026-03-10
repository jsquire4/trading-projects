/**
 * Share URL builder utilities for Meridian web app.
 *
 * Generates properly-encoded share links for X (Twitter), LinkedIn,
 * and internal deep links to market pages.
 */

export function buildXShareUrl(
  ticker: string,
  side: string,
  payout: number,
): string {
  const text = `Just won $${payout} on ${ticker} ${side} on Meridian! \u{1F3AF} #Meridian #BinaryOptions`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

export function buildLinkedInShareUrl(_text: string, url: string): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
}

export function buildMarketDeepLink(ticker: string, strike?: number): string {
  const base = `/trade/${ticker}`;
  if (strike !== undefined) {
    return `${base}?strike=${strike}`;
  }
  return base;
}
