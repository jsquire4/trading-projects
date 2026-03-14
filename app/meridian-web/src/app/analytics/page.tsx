"use client";

import { Component, type ReactNode, useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { useMarkets } from "@/hooks/useMarkets";
import { HistoricalOverlay } from "@/components/analytics/HistoricalOverlay";
import { SettlementAnalytics } from "@/components/analytics/SettlementAnalytics";
import { PriceHistory } from "@/components/analytics/PriceHistory";
import { TickerButton } from "@/components/analytics/TickerButton";
import { useQuotes } from "@/hooks/useAnalyticsData";
import { MAG7 } from "@/lib/tickers";

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

class AnalyticsErrorBoundary extends Component<
  { title: string; children: ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { title: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="text-sm text-red-400/70">
          {this.props.title} failed to load: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return vol.toLocaleString();
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white/5 rounded-xl border border-white/10 card-accent-amber overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 sm:px-6 py-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className={`text-xs transition-transform ${open ? "rotate-180" : ""}`}>&#9660;</span>
      </button>
      {open && <div className="px-4 sm:px-6 pb-6">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline ticker search (validates via market data API)
// ---------------------------------------------------------------------------

function TickerSearch({ onSelect, onCancel }: { onSelect: (ticker: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const validatingRef = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const validate = useCallback(async (ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper || validatingRef.current) return;
    validatingRef.current = true;
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch(`/api/market-data/quotes?symbols=${encodeURIComponent(upper)}`);
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(`Lookup failed (${res.status})`);
        return;
      }
      const data: unknown = await res.json();
      const quotes = (Array.isArray(data) ? data : []) as Array<{ symbol?: string; last?: number }>;
      const valid = quotes.length > 0 && typeof quotes[0]?.last === "number" && quotes[0].last > 0;
      if (valid) {
        onSelect(upper);
      } else {
        setStatus("error");
        setErrorMsg(`"${upper}" not found`);
      }
    } catch {
      setStatus("error");
      setErrorMsg("Validation failed");
    } finally {
      validatingRef.current = false;
    }
  }, [onSelect]);

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value.toUpperCase()); if (status === "error") { setStatus("idle"); setErrorMsg(""); } }}
          onKeyDown={(e) => { if (e.key === "Enter") void validate(value); else if (e.key === "Escape") onCancel(); }}
          placeholder="TICKER"
          maxLength={10}
          className={`w-24 rounded-full border px-3 py-1 text-xs font-mono uppercase bg-white/5 text-white outline-none transition-all placeholder:text-white/20 ${
            status === "error" ? "border-red-500/50 focus:border-red-500/70" : "border-white/20 focus:border-blue-500/50"
          }`}
        />
        {status === "loading" && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border border-white/20 border-t-white/60" />
        )}
      </div>
      <button onClick={onCancel} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/40 hover:bg-white/20 hover:text-white/70 transition-colors text-xs leading-none" aria-label="Cancel">×</button>
      {status === "error" && errorMsg && (
        <div className="absolute left-0 -bottom-6 z-10 whitespace-nowrap rounded bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] text-red-400">{errorMsg}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const [selectedTicker, setSelectedTicker] = useState<string>(MAG7[0]);
  const [extraTickers, setExtraTickers] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const { data: markets } = useMarkets();

  const allTickers = [...MAG7, ...extraTickers];
  const { data: quotes, isLoading: quotesLoading } = useQuotes(allTickers);

  const tickerMarkets = (markets ?? []).filter(
    (m) => m.ticker.toUpperCase() === selectedTicker.toUpperCase(),
  );
  const activeMarkets = tickerMarkets.filter((m) => !m.isSettled);

  const currentQuote = quotes?.find(
    (q) => q.symbol.toUpperCase() === selectedTicker.toUpperCase(),
  );
  const currentPrice = currentQuote?.last ?? 0;
  const change = currentQuote?.change ?? 0;
  const changePct = currentQuote?.change_percentage ?? 0;
  const isPositive = change >= 0;

  return (
    <div className="space-y-6">
      {/* ── Header + Ticker Selector ──────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gradient">Analytics</h1>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide py-1 pr-2">
          {/* MAG7 section */}
          <span className="shrink-0 text-[10px] uppercase tracking-widest text-white/20 px-1 select-none self-center">MAG7</span>
          {(MAG7 as readonly string[]).map((t) => (
            <TickerButton
              key={t}
              ticker={t}
              quote={quotes?.find((q) => q.symbol === t)}
              isSelected={t === selectedTicker}
              onSelect={() => { setSelectedTicker(t); }}
            />
          ))}

          {/* Custom tickers section */}
          {extraTickers.length > 0 && (
            <>
              <span className="shrink-0 w-px h-4 bg-white/10 self-center" />
              <span className="shrink-0 text-[10px] uppercase tracking-widest text-white/20 px-1 select-none self-center">Custom</span>
              {extraTickers.map((t) => (
                <TickerButton
                  key={t}
                  ticker={t}
                  quote={quotes?.find((q) => q.symbol === t)}
                  isSelected={t === selectedTicker}
                  onSelect={() => { setSelectedTicker(t); }}
                  onRemove={() => {
                    setExtraTickers((prev) => prev.filter((x) => x !== t));
                    if (selectedTicker === t) { setSelectedTicker(MAG7[0]); }
                  }}
                />
              ))}
            </>
          )}

          {/* Search */}
          <span className="shrink-0 w-px h-4 bg-white/10 self-center" />
          {searching ? (
            <TickerSearch
              onSelect={(ticker) => {
                if (!allTickers.includes(ticker)) setExtraTickers((prev) => [...prev, ticker]);
                setSelectedTicker(ticker);
                setSearching(false);
              }}
              onCancel={() => setSearching(false)}
            />
          ) : (
            <button
              onClick={() => setSearching(true)}
              className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-white/20 px-3 py-1 text-xs text-white/40 transition-all hover:border-white/40 hover:text-white/70 hover:bg-white/5"
              aria-label="Search for a ticker"
            >
              <span className="text-sm leading-none">+</span>
              <span>Search</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Top Row: Quote Card + Price Chart ─────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Quote + Stats */}
        <div className="lg:col-span-2 bg-white/5 rounded-xl p-4 sm:p-6 border border-white/10 card-accent-green card-glow flex flex-col">
          {quotesLoading ? (
            <div className="animate-pulse flex-1">
              <div className="h-12 bg-white/10 rounded w-48" />
            </div>
          ) : currentQuote && currentPrice > 0 ? (
            <div className="flex flex-col flex-1">
              <div className="text-sm text-white/50 font-medium tracking-wider mb-1">
                {selectedTicker}
              </div>
              <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 mb-4">
                <span className="text-3xl sm:text-4xl font-bold tabular-nums">
                  ${currentPrice.toFixed(2)}
                </span>
                <span
                  className={`text-lg sm:text-xl font-semibold tabular-nums ${
                    isPositive ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {isPositive ? "+" : ""}{change.toFixed(2)}
                </span>
                <span
                  className={`text-base sm:text-lg font-medium tabular-nums ${
                    isPositive ? "text-green-400" : "text-red-400"
                  }`}
                >
                  ({isPositive ? "+" : ""}{changePct.toFixed(2)}%)
                </span>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mb-auto">
                <div>
                  <span className="text-white/40 block text-xs">Prev Close</span>
                  <span className="text-white/80 tabular-nums font-medium">
                    ${(currentQuote.prevclose ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-white/40 block text-xs">Volume</span>
                  <span className="text-white/80 tabular-nums font-medium">
                    {formatVolume(currentQuote.volume ?? 0)}
                  </span>
                </div>
                <div>
                  <span className="text-white/40 block text-xs">Bid / Ask</span>
                  <span className="text-white/80 tabular-nums font-medium">
                    ${(currentQuote.bid ?? 0).toFixed(2)} / ${(currentQuote.ask ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-white/40 block text-xs">Intraday</span>
                  <span
                    className={`tabular-nums font-medium ${
                      isPositive ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {isPositive ? "+" : ""}{changePct.toFixed(2)}%
                  </span>
                </div>
              </div>

              {/* CTA — always at the bottom of the card */}
              <div className="mt-5 pt-4 border-t border-white/10">
                {activeMarkets.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-white/40">
                      {activeMarkets.length} active market{activeMarkets.length !== 1 ? "s" : ""} on Meridian
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      {activeMarkets.map((m) => {
                        const strike = (Number(m.strikePrice) / 1_000_000).toFixed(0);
                        return (
                          <Link
                            key={m.publicKey.toBase58()}
                            href="/trade"
                            className="flex-1 min-w-[120px] text-center rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-sm font-semibold text-green-400 hover:bg-green-500/20 transition-colors"
                          >
                            ${strike} &mdash; Trade
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <Link
                    href="/trade"
                    className="group relative block w-full overflow-hidden rounded-xl border border-white/20 px-6 py-5 text-center transition-all hover:border-white/30 hover:scale-[1.01]"
                  >
                    {/* Animated gradient background */}
                    <div className="absolute inset-0 bg-gradient-to-r from-green-500/20 via-blue-500/20 to-purple-500/20 group-hover:from-green-500/30 group-hover:via-blue-500/30 group-hover:to-purple-500/30 transition-all" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />

                    {/* Shimmer effect */}
                    <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />

                    <div className="relative">
                      <p className="text-xs uppercase tracking-widest text-white/40 mb-1.5">
                        Today&apos;s Question
                      </p>
                      <p className="text-xl font-bold text-white mb-2">
                        Will {selectedTicker} close above{" "}
                        <span className="text-green-400">${Math.round(currentPrice)}</span>?
                      </p>
                      <div className="flex items-center justify-center gap-4 text-sm">
                        <span className="rounded-full bg-green-500/20 border border-green-500/30 px-4 py-1 font-semibold text-green-400">
                          YES
                        </span>
                        <span className="text-white/30">or</span>
                        <span className="rounded-full bg-red-500/20 border border-red-500/30 px-4 py-1 font-semibold text-red-400">
                          NO
                        </span>
                      </div>
                      <p className="text-[11px] text-white/30 mt-2.5">
                        $1 payout per contract &bull; Settles at 4:00 PM ET &bull; Powered by Solana
                      </p>
                    </div>
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
              Loading...
            </div>
          )}
        </div>

        {/* Right: Price History Chart */}
        <div className="lg:col-span-3 bg-white/5 rounded-xl p-4 sm:p-6 border border-white/10 card-accent-green">
          <h2 className="text-lg font-semibold mb-4">Price History</h2>
          <AnalyticsErrorBoundary title="Price History">
            <PriceHistory ticker={selectedTicker} />
          </AnalyticsErrorBoundary>
        </div>
      </div>

      {/* ── Return Distribution (full width) ──────────────────────────── */}
      <div className="bg-white/5 rounded-xl p-4 sm:p-6 border border-white/10 card-accent-purple">
        <h2 className="text-lg font-semibold mb-4">Return Distribution</h2>
        <AnalyticsErrorBoundary title="Historical Distribution">
          <HistoricalOverlay
            ticker={selectedTicker}
            currentPrice={currentPrice > 0 ? currentPrice : undefined}
          />
        </AnalyticsErrorBoundary>
      </div>

      {/* ── Settlement History (collapsible) ───────────────────────────── */}
      <CollapsibleSection title="Settlement History">
        <AnalyticsErrorBoundary title="Settlement Analytics">
          <SettlementAnalytics />
        </AnalyticsErrorBoundary>
      </CollapsibleSection>
    </div>
  );
}
