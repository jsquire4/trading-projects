"use client";

/**
 * TickerSidebar — vertical ticker list for the /trade page.
 *
 * MAG7 tickers always shown, custom tickers below a divider.
 * Click to navigate. "+ Add ticker" input at the bottom.
 */

import { useState, useCallback } from "react";
import Link from "next/link";
import { useWatchlist } from "@/hooks/useWatchlist";
import { useQuotes } from "@/hooks/useAnalyticsData";
import { MAG7 } from "@/lib/tickers";
import { useTickerValidation } from "@/hooks/useTickerValidation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TickerRowProps {
  symbol: string;
  last: number;
  changePct: number;
  isSelected: boolean;
  isCustom: boolean;
  onRemove?: () => void;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TickerRow({ symbol, last, changePct, isSelected, isCustom, onRemove }: TickerRowProps) {
  const isUp = changePct >= 0;
  const hasData = last > 0;

  return (
    <div className="group flex items-center">
      <Link
        href={`/trade/${symbol}`}
        className={`flex-1 flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${
          isSelected
            ? "bg-white/10 text-white"
            : "text-white/60 hover:bg-white/5 hover:text-white/80"
        }`}
      >
        <span className="font-semibold">{symbol}</span>
        {hasData ? (
          <div className="flex items-center gap-2 tabular-nums text-xs">
            <span className="text-white/50">${last.toFixed(2)}</span>
            <span className={isUp ? "text-green-400" : "text-red-400"}>
              {isUp ? "+" : ""}{changePct.toFixed(1)}%
            </span>
          </div>
        ) : (
          <span className="text-white/20 text-xs">—</span>
        )}
      </Link>
      {isCustom && onRemove && (
        <button
          onClick={onRemove}
          className="ml-1 opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 text-xs transition-all px-1"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function TickerSidebar({ selectedTicker }: { selectedTicker?: string }) {
  const { watchlist, customTickers, addTicker, removeTicker } = useWatchlist();
  const { data: quotes = [] } = useQuotes(watchlist);
  const [addingTicker, setAddingTicker] = useState(false);
  const [newTicker, setNewTicker] = useState("");
  const { status, errorMsg, validate, clearError } = useTickerValidation();

  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  const handleAdd = useCallback(async () => {
    const upper = newTicker.trim().toUpperCase();
    if (!upper) return;
    const valid = await validate(upper);
    if (valid) {
      addTicker(upper);
      setNewTicker("");
      setAddingTicker(false);
    }
  }, [newTicker, validate, addTicker]);

  return (
    <div className="w-48 shrink-0 space-y-1">
      {/* MAG7 */}
      <div className="text-[10px] uppercase tracking-widest text-white/20 px-3 py-1">MAG7</div>
      {(MAG7 as readonly string[]).map((symbol) => {
        const q = quoteMap.get(symbol);
        return (
          <TickerRow
            key={symbol}
            symbol={symbol}
            last={q?.last ?? 0}
            changePct={q?.change_percentage ?? 0}
            isSelected={symbol === selectedTicker}
            isCustom={false}
          />
        );
      })}

      {/* Custom tickers */}
      {customTickers.length > 0 && (
        <>
          <div className="h-px bg-white/10 mx-3 my-2" />
          <div className="text-[10px] uppercase tracking-widest text-white/20 px-3 py-1">Watchlist</div>
          {customTickers.map((symbol) => {
            const q = quoteMap.get(symbol);
            return (
              <TickerRow
                key={symbol}
                symbol={symbol}
                last={q?.last ?? 0}
                changePct={q?.change_percentage ?? 0}
                isSelected={symbol === selectedTicker}
                isCustom={true}
                onRemove={() => removeTicker(symbol)}
              />
            );
          })}
        </>
      )}

      {/* Add ticker */}
      <div className="h-px bg-white/10 mx-3 my-2" />
      {addingTicker ? (
        <div className="px-2 space-y-1">
          <div className="flex gap-1">
            <input
              type="text"
              value={newTicker}
              onChange={(e) => {
                setNewTicker(e.target.value.toUpperCase());
                if (status === "error") clearError();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
                if (e.key === "Escape") { setAddingTicker(false); setNewTicker(""); }
              }}
              placeholder="TICKER"
              maxLength={10}
              className="flex-1 min-w-0 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white font-mono uppercase placeholder-white/20 focus:border-accent focus:outline-none"
              autoFocus
            />
            <button
              onClick={() => void handleAdd()}
              disabled={status === "loading" || !newTicker.trim()}
              className="rounded-md bg-accent/20 text-accent text-xs px-2 py-1.5 font-medium hover:bg-accent/30 disabled:opacity-30 transition-colors"
            >
              {status === "loading" ? "..." : "Add"}
            </button>
          </div>
          {status === "error" && errorMsg && (
            <p className="text-[10px] text-red-400 px-1">{errorMsg}</p>
          )}
          <button
            onClick={() => { setAddingTicker(false); setNewTicker(""); }}
            className="text-[10px] text-white/30 hover:text-white/50 px-1"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAddingTicker(true)}
          className="w-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-white/40 hover:text-white/60 hover:bg-white/5 transition-all"
        >
          <span className="text-sm leading-none">+</span>
          <span>Add ticker</span>
        </button>
      )}
    </div>
  );
}
