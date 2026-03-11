"use client";

import { useMemo, useState, useEffect } from "react";
import { useMarkets, useOrderBooks, type ParsedMarket, type OrderBookData } from "@/hooks/useMarkets";
import { MarketCard, type MarketData } from "@/components/MarketCard";
import { WatchlistStrip } from "@/components/WatchlistStrip";
import { MAG7 } from "@/lib/tickers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMarketData(
  m: ParsedMarket,
  ob: OrderBookData | undefined,
): MarketData {
  const yesView = ob?.yesView;
  return {
    ticker: m.ticker,
    strikePrice: Number(m.strikePrice),
    isSettled: m.isSettled,
    outcome: m.outcome,
    bestBid: yesView?.bestBid ?? null,
    bestAsk: yesView?.bestAsk ?? null,
    marketCloseUnix: Number(m.marketCloseUnix),
  };
}

// ---------------------------------------------------------------------------
// Countdown timer — uses earliest active market close time
// ---------------------------------------------------------------------------

function useCountdown(markets: ParsedMarket[]) {
  const [timeLeft, setTimeLeft] = useState("");

  const earliestClose = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled && !m.isClosed);
    if (active.length === 0) return null;
    return Math.min(...active.map((m) => Number(m.marketCloseUnix)));
  }, [markets]);

  useEffect(() => {
    if (!earliestClose) {
      setTimeLeft("");
      return;
    }
    function calc() {
      const now = Math.floor(Date.now() / 1000);
      const diff = earliestClose! - now;
      if (diff <= 0) {
        setTimeLeft("Closed");
        return;
      }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setTimeLeft(`${h}h ${m}m ${s}s`);
    }
    calc();
    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, [earliestClose]);

  return { timeLeft, earliestClose };
}

// ---------------------------------------------------------------------------
// Urgency banner
// ---------------------------------------------------------------------------

function UrgencyBanner({ markets }: { markets: ParsedMarket[] }) {
  const { timeLeft, earliestClose } = useCountdown(markets);

  if (!earliestClose || timeLeft === "Closed") return null;

  // Format close time for display
  const closeDate = new Date(earliestClose * 1000);
  const closeStr = closeDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 px-4 sm:px-5 py-3">
      <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent animate-pulse" />
      <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-0">
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
          Settles at {closeStr} — final answer, no extensions
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticker filter tabs
// ---------------------------------------------------------------------------

function TickerFilterTabs({
  tickers,
  selected,
  onSelect,
  counts,
}: {
  tickers: string[];
  selected: string | null;
  onSelect: (t: string | null) => void;
  counts: Map<string, number>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onSelect(null)}
        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
          selected === null
            ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
            : "text-white/40 hover:text-white/70 hover:bg-white/5"
        }`}
      >
        All
      </button>
      {tickers.map((t) => (
        <button
          key={t}
          onClick={() => onSelect(t === selected ? null : t)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
            t === selected
              ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
              : "text-white/40 hover:text-white/70 hover:bg-white/5"
          }`}
        >
          {t}
          <span className="ml-1.5 text-xs text-white/30">{counts.get(t) ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function SummaryBar({
  totalActive,
  perTicker,
}: {
  totalActive: number;
  perTicker: { ticker: string; count: number }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm">
      <span className="text-white font-semibold">
        {totalActive} active market{totalActive !== 1 ? "s" : ""}
      </span>
      <span className="text-white/20 select-none">|</span>
      {perTicker.map(({ ticker, count }) => (
        <span key={ticker} className="text-white/50">
          <span className="text-white/80 font-medium">{ticker}</span>{" "}
          <span className="text-white/40">{count}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="h-12 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5, 6, 7].map((c) => (
          <div key={c} className="h-8 w-16 rounded-lg bg-white/5 border border-white/10 animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((c) => (
          <div key={c} className="h-52 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradePage() {
  const { data: markets = [], isLoading, isError } = useMarkets();
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);

  // Group active markets by ticker
  const { grouped, totalActive, perTicker, allTickers } = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled && !m.isClosed);
    const map = new Map<string, ParsedMarket[]>();
    for (const m of active) {
      const list = map.get(m.ticker);
      if (!list) map.set(m.ticker, [m]);
      else list.push(m);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(a.strikePrice) - Number(b.strikePrice));
    }

    // Sort tickers: MAG7 first (in canonical order), then alphabetical
    const entries = Array.from(map.entries()).sort(([a], [b]) => {
      const aIdx = MAG7.indexOf(a as (typeof MAG7)[number]);
      const bIdx = MAG7.indexOf(b as (typeof MAG7)[number]);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });

    const grouped = entries.map(([ticker, mkts]) => ({ ticker, markets: mkts }));
    const totalActive = active.length;
    const perTicker = grouped.map(({ ticker, markets: mkts }) => ({
      ticker,
      count: mkts.length,
    }));
    const allTickers = grouped.map((g) => g.ticker);

    return { grouped, totalActive, perTicker, allTickers };
  }, [markets]);

  // Filtered groups
  const filteredGroups = useMemo(
    () => tickerFilter ? grouped.filter((g) => g.ticker === tickerFilter) : grouped,
    [grouped, tickerFilter],
  );

  // Batch-fetch order books for all visible active markets
  const visibleMarketKeys = useMemo(
    () => filteredGroups.flatMap((g) => g.markets.map((m) => m.publicKey)),
    [filteredGroups],
  );
  const { data: orderBooks } = useOrderBooks(visibleMarketKeys);

  // Ticker counts for filter tabs
  const tickerCounts = useMemo(
    () => new Map(perTicker.map((p) => [p.ticker, p.count])),
    [perTicker],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gradient mb-1">Markets</h1>
        <p className="text-white/50 text-sm">
          Binary outcomes on MAG7 stocks. Pick a side, win $1 per contract.
        </p>
      </div>

      {/* Live price strip */}
      <WatchlistStrip />

      {isLoading ? (
        <LoadingSkeleton />
      ) : isError ? (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center text-white/40 text-sm">
          Failed to load markets. Check your connection and try again.
        </div>
      ) : totalActive === 0 ? (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
          <p className="text-white/50 text-sm">No active markets found.</p>
          <p className="text-white/30 text-xs mt-1">
            Markets are created by the admin. Check back soon.
          </p>
        </div>
      ) : (
        <>
          {/* Countdown urgency */}
          <UrgencyBanner markets={markets} />

          {/* Summary bar */}
          <SummaryBar totalActive={totalActive} perTicker={perTicker} />

          {/* Ticker filter tabs */}
          <TickerFilterTabs
            tickers={allTickers}
            selected={tickerFilter}
            onSelect={setTickerFilter}
            counts={tickerCounts}
          />

          {/* Market cards grouped by ticker */}
          <div className="flex flex-col gap-8">
            {filteredGroups.map(({ ticker, markets: mkts }) => (
              <div key={ticker}>
                <h2 className="text-lg font-bold text-white mb-3">{ticker}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {mkts.map((m) => (
                    <MarketCard
                      key={m.publicKey.toBase58()}
                      market={toMarketData(m, orderBooks?.get(m.publicKey.toBase58()))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
