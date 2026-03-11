"use client";

import { useMemo } from "react";
import { useIndexedEvents } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";

export function LiveFillTicker() {
  const { data: events = [] } = useIndexedEvents({ type: "fill", limit: 20 });

  const fills = useMemo(() => {
    return events
      .map((e) => parseFillEvent(e))
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .slice(0, 10);
  }, [events]);

  if (fills.length === 0) return null;

  return (
    <div className="overflow-hidden h-5">
      <div className="flex gap-6 animate-[scroll_30s_linear_infinite] whitespace-nowrap">
        {fills.map((fill, i) => {
          const sideLabel = fill.takerSide === 0 ? "YES" : fill.takerSide === 2 ? "NO" : "SELL";
          const sideColor = fill.takerSide === 0 ? "text-green-400" : fill.takerSide === 2 ? "text-red-400" : "text-amber-400";
          const qty = (fill.quantity / 1_000_000).toFixed(0);
          const ago = Math.max(0, Math.floor(Date.now() / 1000 - fill.timestamp));
          const agoStr = ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`;

          return (
            <span key={`${fill.orderId}-${fill.timestamp}`} className="text-[11px] text-white/40">
              <span className={sideColor}>{qty} {sideLabel}</span>
              {" @ "}{fill.price}c
              {" · "}{agoStr} ago
            </span>
          );
        })}
      </div>
    </div>
  );
}
