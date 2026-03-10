"use client";

import { useMemo } from "react";
import { useFillEvents } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";

interface FillFeedProps {
  marketKey: string;
  limit?: number;
}

export function FillFeed({ marketKey, limit = 20 }: FillFeedProps) {
  const { data: events = [], isLoading } = useFillEvents(marketKey, limit);

  const fills = useMemo(() => {
    return events
      .map((e) => parseFillEvent(e))
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .slice(0, limit);
  }, [events, limit]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">Recent Fills</h3>
        <div className="animate-pulse space-y-1.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-5 rounded bg-white/10" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white/80 mb-2">Recent Fills</h3>
      {fills.length === 0 ? (
        <p className="text-xs text-white/30">No fills yet</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {fills.map((fill, i) => {
            const sideLabel = fill.takerSide === 0 ? "YES" : fill.takerSide === 2 ? "NO" : "SELL";
            const sideColor = fill.takerSide === 0 ? "text-green-400" : fill.takerSide === 2 ? "text-red-400" : "text-amber-400";
            const qty = (fill.quantity / 1_000_000).toFixed(0);
            const ago = Math.max(0, Math.floor(Date.now() / 1000 - fill.timestamp));
            const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;

            return (
              <div key={`${fill.orderId}-${i}`} className="flex items-center justify-between text-[11px]">
                <span className={`font-medium ${sideColor}`}>{sideLabel}</span>
                <span className="text-white/50 tabular-nums">{qty} @ {fill.price}c</span>
                <span className="text-white/30">{agoStr} ago</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
