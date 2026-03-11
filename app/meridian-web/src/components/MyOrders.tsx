"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useMyOrders } from "@/hooks/useMyOrders";
import { useCancelOrder } from "@/hooks/useCancelOrder";

interface MyOrdersProps {
  marketKey: string;
}

const SIDE_LABELS: Record<number, string> = {
  0: "Buy Yes",
  1: "Sell Yes",
  2: "Buy No",
};

const SIDE_COLORS: Record<number, string> = {
  0: "text-green-400",
  1: "text-amber-400",
  2: "text-red-400",
};

export function MyOrders({ marketKey }: MyOrdersProps) {
  const { orders, isLoading } = useMyOrders(marketKey);
  const { publicKey } = useWallet();
  const { cancelOrder, cancellingId } = useCancelOrder(marketKey);

  if (!publicKey) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Orders</h3>
        <p className="text-xs text-white/30">Connect wallet to view orders</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Orders</h3>
        <div className="animate-pulse space-y-2">
          {[1, 2].map((i) => <div key={i} className="h-8 rounded bg-white/10" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white/80 mb-2">
        My Orders {orders.length > 0 && <span className="text-white/40">({orders.length})</span>}
      </h3>
      {orders.length === 0 ? (
        <p className="text-xs text-white/30">No open orders</p>
      ) : (
        <div className="space-y-1.5">
          {orders.map((order) => {
            const idStr = order.orderId.toString();
            const qty = (Number(order.quantity) / 1_000_000).toFixed(0);
            const isCancelling = cancellingId === idStr;

            return (
              <div
                key={idStr}
                className="flex items-center justify-between text-xs bg-white/5 rounded-md px-3 py-2"
              >
                <span className={`font-medium ${SIDE_COLORS[order.side] ?? "text-white/50"}`}>
                  {SIDE_LABELS[order.side] ?? "Unknown"}
                </span>
                <span className="text-white/50 tabular-nums">{qty} @ {order.priceLevel}c</span>
                <button
                  onClick={() => cancelOrder(order.orderId, order.priceLevel)}
                  disabled={isCancelling}
                  className="text-red-400/70 hover:text-red-400 disabled:text-white/20 transition-colors text-[11px] font-medium"
                >
                  {isCancelling ? "..." : "Cancel"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
