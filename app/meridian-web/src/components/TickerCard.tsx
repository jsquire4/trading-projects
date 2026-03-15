"use client";

/**
 * TickerCard — shiny ATM CTA card for the /trade page.
 *
 * Shows the ATM strike with implied probability and direct Buy Yes / Buy No
 * buttons that navigate to the trade page with the modal pre-opened.
 *
 * Carries the gradient/shimmer style from the analytics page quote card.
 */

import Link from "next/link";
import type { ParsedMarket, OrderBookData } from "@/hooks/useMarkets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TickerCardProps {
  ticker: string;
  /** Current price from quotes */
  price: number;
  /** Change percentage */
  changePct: number;
  /** Active (unsettled) markets for this ticker */
  markets: ParsedMarket[];
  /** Order book data keyed by market pubkey string */
  orderBooks?: Map<string, OrderBookData>;
  /** Settlement countdown string */
  countdown: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findATMStrike(markets: ParsedMarket[], currentPrice: number): ParsedMarket | null {
  if (markets.length === 0 || currentPrice <= 0) return null;

  const priceLamports = currentPrice * 1_000_000;
  let closest: ParsedMarket | null = null;
  let closestDist = Infinity;

  for (const m of markets) {
    const dist = Math.abs(Number(m.strikePrice) - priceLamports);
    if (dist < closestDist) {
      closestDist = dist;
      closest = m;
    }
  }

  return closest;
}

function getImpliedProbability(
  market: ParsedMarket,
  orderBooks: Map<string, OrderBookData> | undefined,
): { yesPct: number; noPct: number } | null {
  if (!orderBooks) return null;

  const key = market.publicKey.toBase58();
  const ob = orderBooks.get(key);
  if (!ob) return null;

  const yesView = ob.yesView;
  if (yesView.bestAsk !== null && yesView.bestBid !== null) {
    const mid = Math.round((yesView.bestAsk + yesView.bestBid) / 2);
    return { yesPct: mid, noPct: 100 - mid };
  }
  if (yesView.bestAsk !== null) return { yesPct: yesView.bestAsk, noPct: 100 - yesView.bestAsk };
  if (yesView.bestBid !== null) return { yesPct: yesView.bestBid, noPct: 100 - yesView.bestBid };

  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TickerCard({
  ticker,
  price,
  changePct,
  markets,
  orderBooks,
  countdown,
}: TickerCardProps) {
  const isUp = changePct >= 0;
  const atm = findATMStrike(markets, price);
  const strikeDollars = atm ? (Number(atm.strikePrice) / 1_000_000).toFixed(0) : Math.round(price).toString();
  const implied = atm ? getImpliedProbability(atm, orderBooks) : null;

  const yesPct = implied?.yesPct;
  const noPct = implied?.noPct;

  const totalOpenInterest = markets.reduce((sum, m) => {
    const minted = Number(m.totalMinted);
    const redeemed = Number(m.totalRedeemed);
    return sum + (minted - redeemed);
  }, 0);
  const openInterestDisplay = totalOpenInterest > 0
    ? `$${(totalOpenInterest / 1_000_000).toLocaleString()} open interest`
    : null;

  // Build navigation URLs — goes to /trade/TICKER with the modal pre-opened
  const baseUrl = `/trade/${ticker}`;
  const yesUrl = atm ? `${baseUrl}?market=${atm.publicKey.toBase58()}&action=buy-yes&price=${yesPct}` : baseUrl;
  const noUrl = atm ? `${baseUrl}?market=${atm.publicKey.toBase58()}&action=buy-no&price=${yesPct}` : baseUrl;

  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 transition-all hover:border-white/20 hover:scale-[1.01]">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-green-500/10 via-blue-500/10 to-purple-500/10 group-hover:from-green-500/15 group-hover:via-blue-500/15 group-hover:to-purple-500/15 transition-all" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />

      {/* Shimmer */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />

      <div className="relative px-5 py-5 space-y-4">
        {/* Top row: ticker + price + countdown */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Link href={baseUrl} className="text-lg font-bold text-white hover:text-white/90 transition-colors">
                {ticker}
              </Link>
              {price > 0 && (
                <span className={`text-sm font-semibold tabular-nums ${isUp ? "text-green-400" : "text-red-400"}`}>
                  {isUp ? "▲" : "▼"}{Math.abs(changePct).toFixed(2)}%
                </span>
              )}
            </div>
            {price > 0 && (
              <span className="text-2xl font-bold text-white tabular-nums">${price.toFixed(2)}</span>
            )}
          </div>
          <div className="text-right">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Closes in</span>
            <div className="text-sm font-mono text-white/60">{countdown || "--"}</div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 text-xs text-white/40">
          <span>{markets.length} strike{markets.length !== 1 ? "s" : ""}</span>
          {openInterestDisplay && (
            <>
              <span className="text-white/20">·</span>
              <span>{openInterestDisplay}</span>
            </>
          )}
        </div>

        {/* CTA: Will TICKER close above $STRIKE? */}
        <div className="text-center space-y-3 pt-1">
          <p className="text-xs uppercase tracking-widest text-white/40">
            Today&apos;s Question
          </p>
          <p className="text-base font-bold text-white">
            Will {ticker} close above{" "}
            <span className="text-green-400">${strikeDollars}</span>?
          </p>
          {implied ? (
            <div className="flex items-center gap-3">
              <Link
                href={yesUrl}
                className="flex-1 text-center rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-sm font-semibold text-green-400 hover:bg-green-500/20 transition-colors"
              >
                Yes @ {yesPct}¢
              </Link>
              <Link
                href={noUrl}
                className="flex-1 text-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition-colors"
              >
                No @ {noPct}¢
              </Link>
            </div>
          ) : (
            <Link
              href={baseUrl}
              className="block text-center rounded-lg border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/80 hover:bg-white/10 transition-colors"
            >
              Trade →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
