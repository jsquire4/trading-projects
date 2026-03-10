"use client";

import { useMemo } from "react";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { MarketCard, type MarketData } from "@/components/MarketCard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ParsedMarket (on-chain) into the flat MarketData shape that
 * MarketCard expects. Best bid/ask are not available without loading the
 * full order book per-market, so they are left null here — the card handles
 * that gracefully.
 */
function toMarketData(m: ParsedMarket): MarketData {
  return {
    ticker: m.ticker,
    strikePrice: Number(m.strikePrice),
    isSettled: m.isSettled,
    outcome: m.outcome,
    bestBid: null,
    bestAsk: null,
  };
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

interface SummaryBarProps {
  totalActive: number;
  perTicker: { ticker: string; count: number }[];
}

function SummaryBar({ totalActive, perTicker }: SummaryBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm">
      <span className="text-white font-semibold">
        {totalActive} active market{totalActive !== 1 ? "s" : ""}
      </span>
      <span className="text-white/20 select-none">|</span>
      {perTicker.map(({ ticker, count }) => (
        <span key={ticker} className="text-white/50">
          <span className="text-white/80 font-medium">{ticker}</span>
          {" "}
          <span className="text-white/40">{count}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticker group
// ---------------------------------------------------------------------------

interface TickerGroupProps {
  ticker: string;
  markets: ParsedMarket[];
}

function TickerGroup({ ticker, markets }: TickerGroupProps) {
  return (
    <div>
      <h2 className="text-lg font-bold text-white mb-3">{ticker}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {markets.map((m) => (
          <MarketCard key={m.publicKey.toBase58()} market={toMarketData(m)} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {[1, 2].map((g) => (
        <div key={g}>
          <div className="h-6 w-24 rounded bg-white/10 animate-pulse mb-3" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((c) => (
              <div
                key={c}
                className="h-36 rounded-lg bg-white/5 border border-white/10 animate-pulse"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradePage() {
  const { data: markets = [], isLoading, isError } = useMarkets();

  // Group active markets by ticker, sorted alphabetically
  const grouped = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled && !m.isClosed);

    const map = new Map<string, ParsedMarket[]>();
    for (const m of active) {
      const list = map.get(m.ticker);
      if (!list) {
        map.set(m.ticker, [m]);
      } else {
        list.push(m);
      }
    }

    // Sort each group by strike price ascending
    for (const list of map.values()) {
      list.sort((a, b) => Number(a.strikePrice) - Number(b.strikePrice));
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, mkts]) => ({ ticker, markets: mkts }));
  }, [markets]);

  const totalActive = grouped.reduce((sum, g) => sum + g.markets.length, 0);
  const perTicker = grouped.map(({ ticker, markets: mkts }) => ({
    ticker,
    count: mkts.length,
  }));

  return (
    <div className="flex flex-col gap-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Markets</h1>
        <p className="text-white/50 text-sm">
          0DTE binary outcomes on MAG7 stocks. Contracts settle at 4 PM ET.
        </p>
      </div>

      {/* Summary bar */}
      {!isLoading && !isError && totalActive > 0 && (
        <SummaryBar totalActive={totalActive} perTicker={perTicker} />
      )}

      {/* Content */}
      {isLoading ? (
        <LoadingSkeleton />
      ) : isError ? (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center text-white/40 text-sm">
          Failed to load markets. Check your connection and try again.
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
          <p className="text-white/40 text-sm">No active markets at this time.</p>
          <p className="text-white/30 text-xs mt-2">
            Markets open before trading hours and settle at 4 PM ET.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {grouped.map(({ ticker, markets: mkts }) => (
            <TickerGroup key={ticker} ticker={ticker} markets={mkts} />
          ))}
        </div>
      )}

    </div>
  );
}
