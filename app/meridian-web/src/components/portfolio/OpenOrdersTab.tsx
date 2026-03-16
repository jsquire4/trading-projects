"use client";

import { useMemo } from "react";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { useMyOrders } from "@/hooks/useMyOrders";
import { useCancelOrder } from "@/hooks/useCancelOrder";
import { SIDE_LABELS, SIDE_COLORS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Per-strike order group — strike badge + order pills
// ---------------------------------------------------------------------------

const SIDE_BORDERS: Record<number, string> = {
  0: "border-green-500/20",
  1: "border-amber-500/20",
  2: "border-red-500/20",
};

function StrikeOrderGroup({ market }: { market: ParsedMarket }) {
  const marketKey = market.publicKey.toBase58();
  const strikeDollars = (Number(market.strikePrice) / 1_000_000).toFixed(0);
  const { orders, isLoading } = useMyOrders(marketKey);
  const { cancelOrder, cancellingId } = useCancelOrder(marketKey);

  if (isLoading || orders.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs font-mono text-white/30 bg-white/5 border border-white/10 rounded px-2 py-1 shrink-0">
        {market.ticker} ${strikeDollars}
      </span>
      {orders.map((order) => {
        const idStr = order.orderId.toString();
        const qty = (Number(order.quantity) / 1_000_000).toFixed(0);
        const origQty = (Number(order.originalQuantity) / 1_000_000).toFixed(0);
        const filled = Number(order.originalQuantity) - Number(order.quantity);
        const filledQty = (filled / 1_000_000).toFixed(0);
        const isCancelling = cancellingId === idStr;

        return (
          <div
            key={idStr}
            className={`inline-flex items-center gap-2 rounded-lg border bg-white/5 px-3 py-1.5 text-sm ${SIDE_BORDERS[order.side] ?? "border-white/10"}`}
          >
            <span className={`font-semibold ${SIDE_COLORS[order.side] ?? "text-white/50"}`}>
              {SIDE_LABELS[order.side] ?? "?"}
            </span>
            <span className="text-white/60 font-mono">{order.priceLevel}¢</span>
            <span className="text-white/50 font-mono tabular-nums">
              ×{filled > 0 ? `${filledQty}/${origQty}` : qty}
            </span>
            <button
              onClick={() => cancelOrder(order.orderId, order.priceLevel)}
              disabled={isCancelling}
              className="text-red-400/50 hover:text-red-400 disabled:text-white/20 transition-colors ml-1"
            >
              {isCancelling ? "..." : "✕"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-ticker group — groups strikes under a ticker header
// ---------------------------------------------------------------------------

function TickerOrderGroup({ ticker, markets }: { ticker: string; markets: ParsedMarket[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-white/60">{ticker}</h4>
      {markets.map((m) => (
        <StrikeOrderGroup key={m.publicKey.toBase58()} market={m} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenOrdersTab
// ---------------------------------------------------------------------------

export function OpenOrdersTab() {
  const { data: markets = [], isLoading } = useMarkets();

  // Group markets by ticker, sorted by strike
  const tickerGroups = useMemo(() => {
    const map = new Map<string, ParsedMarket[]>();
    for (const m of markets) {
      const arr = map.get(m.ticker) ?? [];
      arr.push(m);
      map.set(m.ticker, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Number(a.strikePrice) - Number(b.strikePrice));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [markets]);

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-white/5 border border-white/10 animate-pulse" />;
  }

  if (tickerGroups.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
        <p className="text-white/50 text-sm">No open orders</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tickerGroups.map(([ticker, mkts]) => (
        <TickerOrderGroup key={ticker} ticker={ticker} markets={mkts} />
      ))}
    </div>
  );
}
