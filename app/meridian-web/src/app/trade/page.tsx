"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { MarketCard, type MarketData } from "@/components/MarketCard";
import { useTradierQuotes } from "@/hooks/useAnalyticsData";
import { TradeModal } from "@/components/TradeModal";
import { WatchlistStrip } from "@/components/WatchlistStrip";
import { useWatchlist } from "@/hooks/useWatchlist";
import { MAG7 } from "@/lib/tickers";
import { seededRandom, generateSuggestedTrades, type SuggestedTrade } from "@/lib/social-proof";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Countdown timer
// ---------------------------------------------------------------------------

function useCountdown() {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function calc() {
      const now = new Date();
      // 4 PM ET = 21:00 UTC (EST) or 20:00 UTC (EDT)
      // DST detection: compare current offset to Jan/Jul offsets.
      // If a second consumer appears, extract to lib/market-hours.ts.
      const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
      const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
      const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
      const closeHourUTC = isDST ? 20 : 21;
      const close = new Date(now);
      close.setUTCHours(closeHourUTC, 0, 0, 0);
      if (now >= close) {
        close.setUTCDate(close.getUTCDate() + 1);
      }
      const diff = close.getTime() - now.getTime();
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setTimeLeft(`${h}h ${m}m ${s}s`);
    }
    calc();
    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, []);

  return timeLeft;
}

// ---------------------------------------------------------------------------
// Urgency banner
// ---------------------------------------------------------------------------

function UrgencyBanner() {
  const timeLeft = useCountdown();

  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 px-4 sm:px-5 py-3">
      {/* Animated pulse background */}
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
          Settles at 4:00 PM ET — final answer, no extensions
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hot trade card (the dark pattern magnet)
// ---------------------------------------------------------------------------

function HotTradeCard({
  trade,
  onTrade,
}: {
  trade: SuggestedTrade;
  onTrade: (ticker: string, strike: number, side: "YES" | "NO", price: number, currentPrice: number) => void;
}) {
  const isUp = trade.change >= 0;
  const probColor =
    trade.impliedProbYes > 65
      ? "text-green-400"
      : trade.impliedProbYes < 40
        ? "text-red-400"
        : "text-amber-400";

  return (
    <div
      className="group relative block overflow-hidden rounded-xl border border-white/10 bg-white/5 transition-all hover:border-white/20 hover:scale-[1.02] hover:bg-white/[0.07]"
    >
      {/* Momentum badge */}
      {trade.momentum === "hot" && (
        <div className="absolute top-0 right-0 bg-gradient-to-l from-red-500/90 to-orange-500/90 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-bl-lg z-10">
          🔥 Hot
        </div>
      )}
      {trade.momentum === "warm" && (
        <div className="absolute top-0 right-0 bg-gradient-to-l from-amber-500/80 to-yellow-500/80 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-bl-lg z-10">
          ⚡ Moving
        </div>
      )}

      {/* Shimmer on hover */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />

      <div className="relative p-4 sm:p-5">
        {/* Top: Ticker + price */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl font-bold text-white">{trade.ticker}</span>
              <span
                className={`text-sm font-semibold tabular-nums ${
                  isUp ? "text-green-400" : "text-red-400"
                }`}
              >
                {isUp ? "▲" : "▼"} {Math.abs(trade.changePct).toFixed(2)}%
              </span>
            </div>
            <span className="text-white/40 text-sm tabular-nums">
              ${trade.currentPrice.toFixed(2)}
            </span>
          </div>
          <div className="text-right mt-5">
            <div className="text-[10px] uppercase tracking-wider text-white/30 mb-0.5">
              Implied Prob
            </div>
            <div className={`text-2xl font-bold tabular-nums ${probColor}`}>
              {trade.impliedProbYes}%
            </div>
          </div>
        </div>

        {/* The question */}
        <div className="rounded-lg bg-black/30 border border-white/5 px-4 py-3 mb-4">
          <p className="text-sm text-white/70 text-center">
            Will <span className="text-white font-bold">{trade.ticker}</span> close{" "}
            <span className={isUp ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
              {trade.direction}
            </span>{" "}
            <span className="text-white font-bold">${trade.strike}</span> today?
          </p>
        </div>

        {/* Yes / No buttons */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            onClick={() => onTrade(trade.ticker, trade.strike, "YES", trade.impliedProbYes, trade.currentPrice)}
            className="rounded-lg bg-green-500/15 border border-green-500/30 py-2.5 text-center transition-all hover:bg-green-500/25 hover:border-green-500/50 hover:shadow-[0_0_20px_-5px_rgba(34,197,94,0.3)]"
          >
            <div className="text-[10px] uppercase tracking-wider text-green-400/60 mb-0.5">
              Yes
            </div>
            <div className="text-lg font-bold text-green-400">
              {trade.impliedProbYes}¢
            </div>
          </button>
          <button
            onClick={() => onTrade(trade.ticker, trade.strike, "NO", trade.impliedProbYes, trade.currentPrice)}
            className="rounded-lg bg-red-500/15 border border-red-500/30 py-2.5 text-center transition-all hover:bg-red-500/25 hover:border-red-500/50 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]"
          >
            <div className="text-[10px] uppercase tracking-wider text-red-400/60 mb-0.5">
              No
            </div>
            <div className="text-lg font-bold text-red-400">
              {100 - trade.impliedProbYes}¢
            </div>
          </button>
        </div>

        {/* Social proof + win rate (dark pattern) */}
        <div className="flex items-center justify-between text-[11px] text-white/30">
          <span>
            <span className="text-white/50 font-medium">{trade.tradersActive}</span> traders
            today
          </span>
          <span>
            <span className="text-green-400/70 font-medium">{trade.recentWinPct}%</span> win
            rate this week
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "People are trading" ticker tape
// ---------------------------------------------------------------------------

function ActivityTape({ trades }: { trades: SuggestedTrade[] }) {
  const [currentIdx, setCurrentIdx] = useState(0);

  useEffect(() => {
    if (trades.length === 0) return;
    const interval = setInterval(() => {
      setCurrentIdx((i) => (i + 1) % Math.max(trades.length * 3, 1));
    }, 3000);
    return () => clearInterval(interval);
  }, [trades]);

  if (trades.length === 0) return null;

  const names = ["Alex", "Jordan", "Sam", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Avery", "Blake", "Drew", "Kai", "Reese", "Sage", "Finley"];
  const trade = trades[currentIdx % trades.length];
  const name = names[currentIdx % names.length];

  // Human-like YES/NO — biased toward the trade direction but not deterministic
  const sideSeed = seededRandom(`side-${currentIdx}-${trade.ticker}`);
  const side = sideSeed < 0.62 ? "YES" : "NO";

  // Human-like amounts — not round multiples of 5. Mix of small casual bets and larger ones
  const amountSeed = seededRandom(`amt-${currentIdx}-${trade.ticker}`);
  const humanAmounts = [3, 7, 8, 12, 15, 18, 22, 27, 33, 42, 50, 63, 75, 88, 100, 125, 150, 200];
  const amount = humanAmounts[Math.min(Math.floor(amountSeed * humanAmounts.length), humanAmounts.length - 1)];

  return (
    <div className="flex items-center gap-2 text-xs text-white/30 overflow-hidden">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
      </span>
      <span className="truncate">
        <span className="text-white/50">{name}</span> just bought{" "}
        <span className={side === "YES" ? "text-green-400/70" : "text-red-400/70"}>
          {amount} {side}
        </span>{" "}
        on <span className="text-white/50">{trade.ticker}</span> at ${trade.strike}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-bet strip (one-click dark pattern row)
// ---------------------------------------------------------------------------

function QuickBetStrip({
  trades,
  onTrade,
}: {
  trades: SuggestedTrade[];
  onTrade: (ticker: string, strike: number, side: "YES" | "NO", price: number, currentPrice: number) => void;
}) {
  const hotTrades = trades.filter((t) => t.momentum === "hot" || t.momentum === "warm").slice(0, 4);
  if (hotTrades.length === 0) return null;

  return (
    <div className="rounded-xl bg-gradient-to-r from-purple-500/5 via-blue-500/5 to-green-500/5 border border-white/10 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-sm font-semibold text-white/70">Quick Bets — One Click</h3>
        <span className="text-[10px] uppercase tracking-wider text-white/30 hidden sm:inline">
          Most popular today
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {hotTrades.map((t) => {
          const isUp = t.change >= 0;
          return (
            <button
              key={t.ticker}
              onClick={() => onTrade(t.ticker, t.strike, "YES", t.impliedProbYes, t.currentPrice)}
              className="group flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-left transition-all hover:border-green-500/30 hover:bg-green-500/10"
            >
              <div>
                <div className="text-sm font-bold text-white">{t.ticker}</div>
                <div className="text-[10px] text-white/40">
                  {isUp ? "Above" : "Below"} ${t.strike}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-green-400 group-hover:text-green-300">
                  {t.impliedProbYes}¢
                </div>
                <div className="text-[10px] text-white/30">YES</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
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
          <span className="text-white/80 font-medium">{ticker}</span>{" "}
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
      {/* Urgency banner skeleton */}
      <div className="h-12 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
      {/* Quick bets skeleton */}
      <div className="h-24 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
      {/* Card skeletons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((c) => (
          <div
            key={c}
            className="h-52 rounded-xl bg-white/5 border border-white/10 animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradePage() {
  const { data: markets = [], isLoading: marketsLoading, isError } = useMarkets();
  const { watchlist } = useWatchlist();
  const { data: quotes = [], isLoading: quotesLoading } = useTradierQuotes(watchlist);

  const isLoading = marketsLoading || quotesLoading;

  // Generate suggested trades from live quotes
  const mag7Set = new Set(MAG7 as readonly string[]);
  const suggestedTrades = useMemo(() => {
    if (quotes.length === 0) return [];
    return generateSuggestedTrades(quotes);
  }, [quotes]);
  const mag7Trades = suggestedTrades.filter((t) => mag7Set.has(t.ticker));
  const watchlistTrades = suggestedTrades.filter((t) => !mag7Set.has(t.ticker));

  // Group active on-chain markets by ticker
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

  // Trade modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalProps, setModalProps] = useState({
    ticker: "",
    strike: 0,
    side: "YES" as "YES" | "NO",
    price: 50,
    currentPrice: 0,
  });

  const openTradeModal = useCallback(
    (ticker: string, strike: number, side: "YES" | "NO", price: number, currentPrice: number) => {
      setModalProps({ ticker, strike, side, price, currentPrice });
      setModalOpen(true);
    },
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gradient mb-1">Markets</h1>
          <p className="text-white/50 text-sm">
            0DTE binary outcomes on MAG7 stocks. Pick a side, win $1.
          </p>
        </div>
        <div className="hidden sm:block">
          <ActivityTape trades={suggestedTrades} />
        </div>
      </div>

      {/* Live price strip */}
      <WatchlistStrip />

      {isLoading ? (
        <LoadingSkeleton />
      ) : isError ? (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center text-white/40 text-sm">
          Failed to load markets. Check your connection and try again.
        </div>
      ) : (
        <>
          {/* Countdown urgency */}
          <UrgencyBanner />

          {/* Quick bet strip */}
          <QuickBetStrip trades={suggestedTrades} onTrade={openTradeModal} />

          {/* Suggested trades grid — MAG7 */}
          {mag7Trades.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white">
                  Today&apos;s Trades
                </h2>
                <span className="text-xs text-white/30">
                  Based on live market data • Updated every 30s
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {mag7Trades.map((trade) => (
                  <HotTradeCard key={trade.ticker} trade={trade} onTrade={openTradeModal} />
                ))}
              </div>
            </div>
          )}

          {/* Watchlist trades */}
          {watchlistTrades.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white">
                  Your Watchlist
                </h2>
                <span className="text-xs text-white/30">
                  Custom tickers added from watchlist
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {watchlistTrades.map((trade) => (
                  <HotTradeCard key={trade.ticker} trade={trade} onTrade={openTradeModal} />
                ))}
              </div>
            </div>
          )}

          {/* On-chain markets summary */}
          {totalActive > 0 && (
            <>
              <div className="border-t border-white/10 pt-6">
                <SummaryBar totalActive={totalActive} perTicker={perTicker} />
              </div>
              <div className="flex flex-col gap-10">
                {grouped.map(({ ticker, markets: mkts }) => (
                  <TickerGroup key={ticker} ticker={ticker} markets={mkts} />
                ))}
              </div>
            </>
          )}

          {/* Bottom CTA — FOMO inducer */}
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 px-4 sm:px-8 py-8 sm:py-10 text-center card-glow">
            {/* Animated gradient bg */}
            <div className="absolute inset-0 bg-gradient-to-r from-green-500/5 via-blue-500/5 to-purple-500/5" />
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_3s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />

            <div className="relative">
              <p className="text-xs uppercase tracking-widest text-white/30 mb-2">
                Don&apos;t miss out
              </p>
              <h2 className="text-xl sm:text-2xl font-bold text-gradient mb-2">
                Markets Are Open Now
              </h2>
              <p className="text-white/40 text-sm mb-5 max-w-md mx-auto">
                Every contract settles at 4 PM ET. $1 in, $1 out.
                The odds are right there — will you take the bet?
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-sm text-white/30">
                <span>
                  <span className="text-green-400 font-bold">{suggestedTrades.length}</span>{" "}
                  tickers live
                </span>
                <span className="text-white/10">|</span>
                <span>
                  <span className="text-blue-400 font-bold">
                    {suggestedTrades.reduce((s, t) => s + t.tradersActive, 0)}
                  </span>{" "}
                  traders active
                </span>
                <span className="text-white/10">|</span>
                <span>
                  <span className="text-purple-400 font-bold">$1</span> per contract
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Trade modal */}
      <TradeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        ticker={modalProps.ticker}
        strike={modalProps.strike}
        currentPrice={modalProps.currentPrice}
        side={modalProps.side}
        price={modalProps.price}
      />
    </div>
  );
}
