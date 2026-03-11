"use client";

import { useMemo } from "react";
import type { ParsedMarket, OrderBookData } from "@/hooks/useMarkets";
import { useOrderBooks } from "@/hooks/useMarkets";

interface QuoteTableProps {
  markets: ParsedMarket[];
}

function MarketRow({
  market,
  book,
}: {
  market: ParsedMarket;
  book: OrderBookData | null;
}) {
  const strikeDollars = Number(market.strikePrice) / 1_000_000;
  const totalMinted = Number(market.totalMinted) / 1_000_000;

  const bestBid = book?.yesView.bestBid ?? null;
  const bestAsk = book?.yesView.bestAsk ?? null;
  const spread = book?.yesView.spread ?? null;
  const spreadBps = bestAsk && bestBid ? Math.round((spread ?? 0) / ((bestBid + bestAsk) / 2) * 10000) : null;

  // Simple inventory proxy: count of resting bid vs ask orders
  const bidQty = useMemo(() => {
    if (!book) return 0;
    return book.yesView.bids.reduce((sum, l) => sum + Number(l.totalQuantity), 0) / 1_000_000;
  }, [book]);

  const askQty = useMemo(() => {
    if (!book) return 0;
    return book.yesView.asks.reduce((sum, l) => sum + Number(l.totalQuantity), 0) / 1_000_000;
  }, [book]);

  return (
    <tr className="border-b border-white/5 hover:bg-white/5">
      <td className="py-2 px-3 text-white font-medium">{market.ticker}</td>
      <td className="py-2 px-3 text-white/60 font-mono">${strikeDollars.toFixed(0)}</td>
      <td className="py-2 px-3 text-green-400 font-mono tabular-nums">{bestBid ?? "--"}c</td>
      <td className="py-2 px-3 text-red-400 font-mono tabular-nums">{bestAsk ?? "--"}c</td>
      <td className="py-2 px-3 text-white/50 font-mono tabular-nums">
        {spread !== null ? `${spread}c` : "--"}
        {spreadBps !== null && <span className="text-white/30 ml-1">({spreadBps}bp)</span>}
      </td>
      <td className="py-2 px-3 text-white/50 tabular-nums">{totalMinted.toFixed(0)}</td>
      <td className="py-2 px-3">
        <div className="flex items-center gap-1">
          <div className="w-16 h-2 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-400/50 rounded-full"
              style={{ width: `${Math.min(100, (bidQty / (bidQty + askQty + 0.001)) * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-white/30">{bidQty.toFixed(0)}b/{askQty.toFixed(0)}a</span>
        </div>
      </td>
      <td className="py-2 px-3">
        {market.isPaused ? (
          <span className="text-[10px] text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded">PAUSED</span>
        ) : (
          <span className="text-[10px] text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded">ACTIVE</span>
        )}
      </td>
    </tr>
  );
}

export function QuoteTable({ markets }: QuoteTableProps) {
  const marketKeys = useMemo(() => markets.map((m) => m.publicKey), [markets]);
  const { data: books } = useOrderBooks(marketKeys);

  if (markets.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-10 text-center">
        <p className="text-white/50 text-sm">No active markets to display.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-x-auto">
      <table className="w-full text-xs min-w-[640px]">
        <thead>
          <tr className="text-white/40 text-left border-b border-white/10">
            <th className="py-3 px-3 font-medium">Ticker</th>
            <th className="py-3 px-3 font-medium">Strike</th>
            <th className="py-3 px-3 font-medium">Best Bid</th>
            <th className="py-3 px-3 font-medium">Best Ask</th>
            <th className="py-3 px-3 font-medium">Spread</th>
            <th className="py-3 px-3 font-medium">Volume</th>
            <th className="py-3 px-3 font-medium">Inventory</th>
            <th className="py-3 px-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <MarketRow
              key={m.publicKey.toBase58()}
              market={m}
              book={books?.get(m.publicKey.toBase58()) ?? null}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
