"use client";

import { useMemo } from "react";
import { useMarkets } from "@/hooks/useMarkets";
import { useMyOrders } from "@/hooks/useMyOrders";
import { useCancelOrder } from "@/hooks/useCancelOrder";

const SIDE_LABELS: Record<number, string> = { 0: "Buy Yes", 1: "Sell Yes", 2: "Sell No" };
const SIDE_COLORS: Record<number, string> = { 0: "text-green-400", 1: "text-amber-400", 2: "text-red-400" };

function MarketOrders({ marketKey, ticker, strike }: { marketKey: string; ticker: string; strike: number }) {
  const { orders, isLoading } = useMyOrders(marketKey);
  const { cancelOrder, cancellingId } = useCancelOrder(marketKey);

  if (isLoading || orders.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-xs text-white/40 font-medium px-1">
        {ticker} ${strike.toFixed(0)}
      </div>
      {orders.map((order) => {
        const idStr = order.orderId.toString();
        const qty = (Number(order.quantity) / 1_000_000).toFixed(0);
        return (
          <div key={idStr} className="flex items-center justify-between text-xs bg-white/5 rounded-md px-3 py-2">
            <span className={`font-medium ${SIDE_COLORS[order.side] ?? "text-white/50"}`}>
              {SIDE_LABELS[order.side] ?? "Unknown"}
            </span>
            <span className="text-white/50 tabular-nums">{qty} @ {order.priceLevel}c</span>
            <button
              onClick={() => cancelOrder(order.orderId, order.priceLevel)}
              disabled={cancellingId === idStr}
              className="text-red-400/70 hover:text-red-400 disabled:text-white/20 transition-colors text-[11px] font-medium"
            >
              {cancellingId === idStr ? "..." : "Cancel"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function OpenOrdersTab() {
  const { data: markets = [], isLoading } = useMarkets();
  // Show all non-closed markets (including settled — user may need to cancel orders there)
  const visibleMarkets = useMemo(
    () => markets.filter((m) => !m.isClosed),
    [markets],
  );

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-white/5 border border-white/10 animate-pulse" />;
  }

  if (visibleMarkets.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
        <p className="text-white/50 text-sm">No markets with open orders</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {visibleMarkets.map((m) => (
        <MarketOrders
          key={m.publicKey.toBase58()}
          marketKey={m.publicKey.toBase58()}
          ticker={m.ticker}
          strike={Number(m.strikePrice) / 1_000_000}
        />
      ))}
    </div>
  );
}
