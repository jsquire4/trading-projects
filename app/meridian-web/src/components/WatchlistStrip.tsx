"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { useWatchlist } from "@/hooks/useWatchlist";
import { useTradierQuotes } from "@/hooks/useAnalyticsData";
import { MAG7 } from "@/lib/tickers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TickerPillProps {
  symbol: string;
  last: number;
  changePct: number;
  isCustom: boolean;
  onRemove?: (symbol: string) => void;
}

// ---------------------------------------------------------------------------
// Ticker pill
// ---------------------------------------------------------------------------

function TickerPill({ symbol, last, changePct, isCustom, onRemove }: TickerPillProps) {
  const isUp = changePct >= 0;
  const hasData = last > 0;

  return (
    <div className="group relative flex items-center shrink-0">
      <Link
        href={`/trade/${symbol}`}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all
          ${hasData
            ? isUp
              ? "border-green-500/20 bg-green-500/5 hover:border-green-500/40 hover:bg-green-500/10"
              : "border-red-500/20 bg-red-500/5 hover:border-red-500/40 hover:bg-red-500/10"
            : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
          }
          ${isCustom ? "pr-1.5" : ""}
        `}
      >
        <span className="font-semibold text-white/90">{symbol}</span>
        {hasData ? (
          <>
            <span className="tabular-nums text-white/60">${last.toFixed(2)}</span>
            <span
              className={`tabular-nums font-medium ${
                isUp ? "text-green-400" : "text-red-400"
              }`}
            >
              {isUp ? "▲" : "▼"}{Math.abs(changePct).toFixed(2)}%
            </span>
          </>
        ) : (
          <span className="text-white/30">—</span>
        )}
      </Link>

      {/* Remove button for custom tickers — visible on group hover */}
      {isCustom && onRemove && (
        <button
          onClick={(e) => {
            e.preventDefault();
            onRemove(symbol);
          }}
          className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/40 hover:bg-red-500/30 hover:text-red-400 transition-colors text-[10px] leading-none"
          aria-label={`Remove ${symbol}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section label
// ---------------------------------------------------------------------------

function SectionLabel({ label }: { label: string }) {
  return (
    <span className="shrink-0 text-[10px] uppercase tracking-widest text-white/20 px-1 select-none self-center">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

function PillDivider() {
  return <span className="shrink-0 w-px h-4 bg-white/10 self-center" />;
}

// ---------------------------------------------------------------------------
// Add ticker inline input
// ---------------------------------------------------------------------------

interface AddTickerInputProps {
  onAdd: (ticker: string) => void;
  onCancel: () => void;
}

function AddTickerInput({ onAdd, onCancel }: AddTickerInputProps) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cancelledRef = useRef(false);
  const validatingRef = useRef(false);

  useEffect(() => {
    return () => { cancelledRef.current = true; };
  }, []);

  const validate = useCallback(async (ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper || validatingRef.current) return;
    validatingRef.current = true;

    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch(`/api/tradier/quotes?symbols=${encodeURIComponent(upper)}`);
      if (cancelledRef.current) return;
      const data = await res.json();
      if (cancelledRef.current) return;
      const quote = data.quotes?.quote;
      const valid =
        quote &&
        (Array.isArray(quote) ? quote[0]?.last > 0 : quote?.last > 0);

      if (valid) {
        onAdd(upper);
      } else {
        setStatus("error");
        setErrorMsg(`"${upper}" not found or not tradeable`);
      }
    } catch {
      if (cancelledRef.current) return;
      setStatus("error");
      setErrorMsg("Validation failed — check connection");
    } finally {
      validatingRef.current = false;
    }
  }, [onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        void validate(value);
      } else if (e.key === "Escape") {
        onCancel();
      }
    },
    [value, validate, onCancel],
  );

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            if (status === "error") {
              setStatus("idle");
              setErrorMsg("");
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="TICKER"
          maxLength={10}
          className={`w-24 rounded-full border px-3 py-1 text-xs font-mono uppercase bg-white/5 text-white outline-none transition-all
            placeholder:text-white/20
            ${status === "error"
              ? "border-red-500/50 focus:border-red-500/70"
              : "border-white/20 focus:border-blue-500/50"
            }
          `}
        />
        {status === "loading" && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border border-white/20 border-t-white/60" />
        )}
      </div>

      {/* Cancel */}
      <button
        onClick={onCancel}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/40 hover:bg-white/20 hover:text-white/70 transition-colors text-xs leading-none"
        aria-label="Cancel"
      >
        ×
      </button>

      {/* Inline error tooltip */}
      {status === "error" && errorMsg && (
        <div className="absolute left-0 -bottom-6 z-10 whitespace-nowrap rounded bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] text-red-400">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WatchlistStrip
// ---------------------------------------------------------------------------

export function WatchlistStrip() {
  const { watchlist, addTicker, removeTicker } = useWatchlist();
  const { data: quotes = [], isLoading } = useTradierQuotes(watchlist);
  const [adding, setAdding] = useState(false);

  // Build a quick lookup map: symbol → quote data
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  const mag7Tickers = MAG7 as readonly string[];
  const customTickers = watchlist.filter((t) => !mag7Tickers.includes(t));

  const handleAdd = useCallback(
    (ticker: string) => {
      addTicker(ticker);
      setAdding(false);
    },
    [addTicker],
  );

  // Skeleton pills during initial load
  if (isLoading && quotes.length === 0) {
    return (
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide py-1">
        {mag7Tickers.map((t) => (
          <div
            key={t}
            className="shrink-0 h-6 w-24 rounded-full bg-white/5 border border-white/10 animate-pulse"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 overflow-x-auto scrollbar-hide py-1 pr-2"
    >
      {/* MAG7 section */}
      <SectionLabel label="MAG7" />
      {mag7Tickers.map((symbol) => {
        const q = quoteMap.get(symbol);
        return (
          <TickerPill
            key={symbol}
            symbol={symbol}
            last={q?.last ?? 0}
            changePct={q?.change_percentage ?? 0}
            isCustom={false}
          />
        );
      })}

      {/* Custom tickers section */}
      {customTickers.length > 0 && (
        <>
          <PillDivider />
          <SectionLabel label="Watchlist" />
          {customTickers.map((symbol) => {
            const q = quoteMap.get(symbol);
            return (
              <TickerPill
                key={symbol}
                symbol={symbol}
                last={q?.last ?? 0}
                changePct={q?.change_percentage ?? 0}
                isCustom={true}
                onRemove={removeTicker}
              />
            );
          })}
        </>
      )}

      {/* Add button / inline input */}
      <PillDivider />
      {adding ? (
        <AddTickerInput
          onAdd={handleAdd}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-white/20 px-3 py-1 text-xs text-white/40 transition-all hover:border-white/40 hover:text-white/70 hover:bg-white/5"
          aria-label="Add ticker to watchlist"
        >
          <span className="text-sm leading-none">+</span>
          <span>Add</span>
        </button>
      )}
    </div>
  );
}
