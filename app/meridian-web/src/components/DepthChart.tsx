"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, formatCompact } from "@/lib/chartConfig";

interface DepthLevel {
  price: number;
  quantity: number;
  cumulative: number;
}

interface DepthChartProps {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

interface ChartPoint {
  price: number;
  bidCum: number | null;
  askCum: number | null;
}

export function DepthChart({ bids, asks }: DepthChartProps) {
  const chartData = useMemo<ChartPoint[]>(() => {
    // Bids: sort low-to-high by price, then accumulate right-to-left
    // (highest price has its own qty, next lower has its qty + above, etc.)
    // This way each point shows "total quantity available at this price or better"
    const sortedBids = [...bids].sort((a, b) => a.price - b.price);
    let bidRunning = 0;
    const bidCumulatives: number[] = new Array(sortedBids.length);
    for (let i = sortedBids.length - 1; i >= 0; i--) {
      bidRunning += sortedBids[i].quantity;
      bidCumulatives[i] = bidRunning;
    }
    const bidPoints: ChartPoint[] = sortedBids.map((l, i) => ({
      price: l.price,
      bidCum: bidCumulatives[i] / 1_000_000,
      askCum: null,
    }));

    // Asks: sort low-to-high, accumulate left-to-right
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
    let askRunning = 0;
    const askPoints: ChartPoint[] = sortedAsks.map((l) => {
      askRunning += l.quantity;
      return {
        price: l.price,
        bidCum: null,
        askCum: askRunning / 1_000_000,
      };
    });

    if (bidPoints.length === 0 && askPoints.length === 0) return [];

    // Midpoint gap entry between last bid and first ask
    const lastBid = bidPoints[bidPoints.length - 1];
    const firstAsk = askPoints[0];
    const midEntries: ChartPoint[] = [];

    if (lastBid && firstAsk) {
      const midPrice = (lastBid.price + firstAsk.price) / 2;
      midEntries.push({ price: midPrice, bidCum: null, askCum: null });
    }

    return [...bidPoints, ...midEntries, ...askPoints];
  }, [bids, asks]);

  if (chartData.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-xs text-white/30">
        No depth data
      </div>
    );
  }

  return (
    <div className="px-2 py-3">
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="depthBidGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLORS.yes} stopOpacity={0.3} />
              <stop offset="95%" stopColor={COLORS.yes} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="depthAskGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLORS.no} stopOpacity={0.3} />
              <stop offset="95%" stopColor={COLORS.no} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid vertical={false} {...GRID_STYLE} />

          <XAxis
            dataKey="price"
            tickFormatter={(v: number) => `${v}c`}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
          />

          <YAxis hide />

          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={(label: unknown) => `Price: ${label}c`}
            formatter={(value: unknown, name: unknown) => {
              const label = name === "bidCum" ? "Bid depth" : "Ask depth";
              return [formatCompact(Number(value)), label];
            }}
          />

          <Area
            type="stepAfter"
            dataKey="bidCum"
            stroke={COLORS.yes}
            strokeWidth={1.5}
            fill="url(#depthBidGradient)"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />

          <Area
            type="stepAfter"
            dataKey="askCum"
            stroke={COLORS.no}
            strokeWidth={1.5}
            fill="url(#depthAskGradient)"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
