"use client";

import { useState, useMemo } from "react";
import { useOrderBook } from "@/hooks/useMarkets";

interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookView {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

interface OrderBookProps {
  perspective: "yes" | "no";
  marketKey: string;
}

export function OrderBook({ perspective: initialPerspective, marketKey }: OrderBookProps) {
  const [perspective, setPerspective] = useState<"yes" | "no">(initialPerspective);
  const { data: book, isLoading } = useOrderBook(marketKey);

  const { bids, asks, spread, maxCumulative } = useMemo(() => {
    if (!book) return { bids: [], asks: [], spread: null, maxCumulative: 1 };

    // Use the pre-computed Yes/No views from the deserializer
    const view = perspective === "yes" ? book.yesView : book.noView;

    const displayBids: OrderBookLevel[] = view.bids.map((l) => ({
      price: l.price,
      quantity: Number(l.totalQuantity),
    }));
    const displayAsks: OrderBookLevel[] = view.asks.map((l) => ({
      price: l.price,
      quantity: Number(l.totalQuantity),
    }));

    // Compute cumulative quantities
    let cumBids = 0;
    const bidsWithCum = displayBids.map((l) => {
      cumBids += l.quantity;
      return { ...l, cumulative: cumBids };
    });

    let cumAsks = 0;
    const asksWithCum = [...displayAsks].reverse().map((l) => {
      cumAsks += l.quantity;
      return { ...l, cumulative: cumAsks };
    }).reverse();

    const maxCum = Math.max(cumBids, cumAsks, 1);

    return {
      bids: bidsWithCum,
      asks: asksWithCum,
      spread: view.spread,
      maxCumulative: maxCum,
    };
  }, [book, perspective]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="animate-pulse space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-6 rounded bg-white/10" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5">
      {/* Header with perspective toggle */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <h3 className="text-sm font-semibold text-white/80">Order Book</h3>
        <div className="flex rounded-md border border-white/10 text-xs">
          <button
            onClick={() => setPerspective("yes")}
            className={`px-3 py-1 transition-colors ${
              perspective === "yes"
                ? "bg-yes/20 text-yes"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            Yes
          </button>
          <button
            onClick={() => setPerspective("no")}
            className={`px-3 py-1 transition-colors ${
              perspective === "no"
                ? "bg-no/20 text-no"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            No
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-3 gap-1 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-white/40">
        <span>Price</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Depth</span>
      </div>

      {/* Asks (reversed so lowest ask is at bottom, closest to spread) */}
      <div className="flex flex-col-reverse">
        {asks.slice(0, 8).map((level) => (
          <div
            key={level.price}
            className="relative grid grid-cols-3 gap-1 px-4 py-0.5 text-xs"
          >
            <div
              className="absolute inset-y-0 right-0 bg-no/10"
              style={{ width: `${(level.cumulative / maxCumulative) * 100}%` }}
            />
            <span className="relative text-no">{level.price}c</span>
            <span className="relative text-right text-white/70">
              {(level.quantity / 1_000_000).toLocaleString()}
            </span>
            <span className="relative text-right text-white/40">
              {(level.cumulative / 1_000_000).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Spread */}
      <div className="border-y border-white/10 px-4 py-1.5 text-center text-xs text-white/50">
        {spread !== null ? (
          <>Spread: <span className="font-medium text-white/80">{spread}c</span></>
        ) : (
          "No spread"
        )}
      </div>

      {/* Bids */}
      <div>
        {bids.slice(0, 8).map((level) => (
          <div
            key={level.price}
            className="relative grid grid-cols-3 gap-1 px-4 py-0.5 text-xs"
          >
            <div
              className="absolute inset-y-0 right-0 bg-yes/10"
              style={{ width: `${(level.cumulative / maxCumulative) * 100}%` }}
            />
            <span className="relative text-yes">{level.price}c</span>
            <span className="relative text-right text-white/70">
              {(level.quantity / 1_000_000).toLocaleString()}
            </span>
            <span className="relative text-right text-white/40">
              {(level.cumulative / 1_000_000).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
