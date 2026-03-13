"use client";

import { useMemo, useState, useEffect } from "react";
import { useFillEvents, useEventIndexerStatus } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";

interface FillFeedProps {
  marketKey: string;
  limit?: number;
}

export function FillFeed({ marketKey, limit = 20 }: FillFeedProps) {
  const { data: events = [], isLoading } = useFillEvents(marketKey, limit);
  const { isOffline } = useEventIndexerStatus();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Tick every 15s so relative timestamps stay fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

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
      {isOffline ? (
        <div className="flex items-center gap-2 text-[11px] text-amber-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          Event indexer offline
        </div>
      ) : fills.length === 0 ? (
        <p className="text-xs text-white/30">No fills yet</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {fills.map((fill, i) => {
            // Direction-neutral: market-wide feed has no viewer context
            const tokenType = fill.takerSide === 2 ? "No" : "Yes";
            const tokenColor = fill.takerSide === 2 ? "text-red-400" : "text-green-400";
            const qty = (fill.quantity / 1_000_000).toFixed(0);
            const ago = Math.max(0, now - fill.timestamp);
            const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;

            return (
              <div key={`${fill.signature}-${fill.seq ?? i}`} className="flex items-center justify-between text-[11px]">
                <span className={`font-medium ${tokenColor}`}>{tokenType}</span>
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
