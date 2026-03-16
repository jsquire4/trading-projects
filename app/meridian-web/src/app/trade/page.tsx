"use client";

import { useMemo, useState, useEffect } from "react";
import { useMarkets, useOrderBooks, type ParsedMarket } from "@/hooks/useMarkets";
import { useQuotes } from "@/hooks/useAnalyticsData";
import { TickerCard } from "@/components/TickerCard";
import { TickerSidebar } from "@/components/TickerSidebar";
import { LiveFillTicker } from "@/components/LiveFillTicker";
import { SyntheticControls } from "@/components/SyntheticControls";
import { useWatchlist } from "@/hooks/useWatchlist";

// ---------------------------------------------------------------------------
// Countdown hook — earliest active market close
// ---------------------------------------------------------------------------

function useCountdown(markets: ParsedMarket[]) {
  const earliestClose = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled);
    if (active.length === 0) return null;
    return Math.min(...active.map((m) => Number(m.marketCloseUnix)));
  }, [markets]);

  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    if (!earliestClose) { setTimeLeft(""); return; }
    function calc() {
      const now = Math.floor(Date.now() / 1000);
      const diff = earliestClose! - now;
      if (diff <= 0) { setTimeLeft("Closed"); return; }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setTimeLeft(`${h}h ${m}m ${s}s`);
    }
    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [earliestClose]);

  return timeLeft;
}

// ---------------------------------------------------------------------------
// Urgency Banner
// ---------------------------------------------------------------------------

function UrgencyBanner({ markets }: { markets: ParsedMarket[] }) {
  const timeLeft = useCountdown(markets);

  if (!timeLeft || timeLeft === "Closed") return null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 px-5 py-3">
      <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent animate-pulse" />
      <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-1">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
          </span>
          <span className="text-sm font-semibold text-amber-200">
            Markets close in{" "}
            <span className="text-amber-400 tabular-nums font-bold">{timeLeft}</span>
          </span>
        </div>
        <span className="text-xs text-amber-200/50 ml-6 sm:ml-0">
          Settles at close — outcome may be reviewed briefly after settlement
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradePage() {
  const { data: markets = [], isLoading, isError } = useMarkets();
  const { watchlist } = useWatchlist();
  const { data: quotes = [] } = useQuotes(watchlist);

  const quoteMap = useMemo(
    () => new Map(quotes.map((q) => [q.symbol, q])),
    [quotes],
  );

  // Group active markets by ticker, sorted by aggregate open interest
  const tickerGroups = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled);
    const map = new Map<string, ParsedMarket[]>();
    for (const m of active) {
      const arr = map.get(m.ticker) ?? [];
      arr.push(m);
      map.set(m.ticker, arr);
    }

    const groups: { ticker: string; markets: ParsedMarket[]; openInterest: number }[] = [];
    for (const [ticker, mkts] of map) {
      const oi = mkts.reduce((sum, m) => sum + Number(m.totalMinted) - Number(m.totalRedeemed), 0);
      groups.push({ ticker, markets: mkts, openInterest: oi });
    }

    groups.sort((a, b) => b.openInterest - a.openInterest);
    return groups;
  }, [markets]);

  // Tickers from watchlist with no active markets
  const noMarketTickers = useMemo(() => {
    const withMarkets = new Set(tickerGroups.map((g) => g.ticker));
    return watchlist.filter((t) => !withMarkets.has(t));
  }, [tickerGroups, watchlist]);

  // Batch order books for all visible markets
  const visibleMarketKeys = useMemo(
    () => tickerGroups.flatMap((g) => g.markets.map((m) => m.publicKey)),
    [tickerGroups],
  );
  const { data: orderBooks } = useOrderBooks(visibleMarketKeys);

  const countdown = useCountdown(markets);

  return (
    <div className="flex gap-6">
      {/* Sidebar */}
      <div className="hidden lg:block">
        <TickerSidebar />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col gap-6 min-w-0">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gradient mb-1">Markets</h1>
          <p className="text-white/50 text-sm">
            Binary outcomes on MAG7 stocks. Pick a side, win $1 per contract.
          </p>
        </div>

        {/* Synthetic mode controls */}
        <SyntheticControls />

        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-52 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center text-white/40 text-sm">
            Failed to load markets. Check your connection and try again.
          </div>
        ) : tickerGroups.length === 0 && noMarketTickers.length === 0 ? (
          <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
            <p className="text-white/50 text-sm">No active markets found.</p>
            <p className="text-white/30 text-xs mt-1">
              Add a ticker from the sidebar to create a market and start trading.
            </p>
          </div>
        ) : (
          <>
            {/* Urgency banner */}
            <UrgencyBanner markets={markets} />

            {/* Ticker cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {tickerGroups.map(({ ticker, markets: mkts }) => {
                const q = quoteMap.get(ticker);
                return (
                  <TickerCard
                    key={ticker}
                    ticker={ticker}
                    price={q?.last ?? 0}
                    changePct={q?.change_percentage ?? 0}
                    markets={mkts}
                    orderBooks={orderBooks}
                    countdown={countdown}
                  />
                );
              })}

              {/* Tickers with no markets yet */}
              {noMarketTickers.map((ticker) => {
                const q = quoteMap.get(ticker);
                return (
                  <TickerCard
                    key={ticker}
                    ticker={ticker}
                    price={q?.last ?? 0}
                    changePct={q?.change_percentage ?? 0}
                    markets={[]}
                    orderBooks={undefined}
                    countdown=""
                  />
                );
              })}
            </div>
          </>
        )}

        {/* FOMO feed */}
        <LiveFillTicker />
      </div>
    </div>
  );
}
