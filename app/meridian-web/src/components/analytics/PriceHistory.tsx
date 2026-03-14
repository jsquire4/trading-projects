"use client";

/**
 * PriceHistory — Stock price chart showing the last ~90 trading days of OHLCV data.
 * Uses an AreaChart with gradient fill for visual appeal.
 */

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { useHistory } from "@/hooks/useAnalyticsData";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatDollar,
} from "@/lib/chartConfig";

interface PriceHistoryProps {
  ticker: string;
  /** Number of calendar days to fetch (default 120 → ~90 trading days) */
  days?: number;
}

export function PriceHistory({ ticker, days = 120 }: PriceHistoryProps) {
  const { data: history, isLoading, isError } = useHistory(ticker, days);

  const chartData = useMemo(() => {
    if (!history || history.length === 0) return [];
    return history.map((bar) => ({
      date: bar.date,
      // Format as "Mar 10" for display
      label: new Date(bar.date + "T12:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      close: bar.close,
      high: bar.high,
      low: bar.low,
      volume: bar.volume,
    }));
  }, [history]);

  const [yMin, yMax] = useMemo(() => {
    if (chartData.length === 0) return [0, 100];
    const lows = chartData.map((d) => d.low);
    const highs = chartData.map((d) => d.high);
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const pad = (max - min) * 0.05;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Loading price history for {ticker}...
      </div>
    );
  }

  if (isError || !history || history.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Price history unavailable for {ticker}
      </div>
    );
  }

  const firstClose = chartData[0]?.close ?? 0;
  const lastClose = chartData[chartData.length - 1]?.close ?? 0;
  const periodChange = lastClose - firstClose;
  const isPositive = periodChange >= 0;
  const lineColor = isPositive ? COLORS.yes : COLORS.no;

  return (
    <div className="w-full space-y-2">
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart
          data={chartData}
          margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
        >
          <defs>
            <linearGradient id={`priceGrad-${ticker}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid {...GRID_STYLE} />

          <XAxis
            dataKey="label"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={40}
          />

          <YAxis
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            domain={[yMin, yMax]}
            tickFormatter={(v: number) => `$${v}`}
            width={56}
          />

          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value: unknown) => [formatDollar(Number(value)), "Close"]}
            labelFormatter={(label: unknown) => String(label)}
          />

          <Area
            type="monotone"
            dataKey="close"
            stroke={lineColor}
            strokeWidth={2}
            fill={`url(#priceGrad-${ticker})`}
            dot={false}
            activeDot={{ r: 4, fill: lineColor }}
          />
        </AreaChart>
      </ResponsiveContainer>

      <p className="text-[10px] text-zinc-600">
        {chartData.length} trading days shown. Period change:{" "}
        <span className={isPositive ? "text-green-400" : "text-red-400"}>
          {isPositive ? "+" : ""}
          {formatDollar(periodChange)} ({isPositive ? "+" : ""}
          {firstClose > 0 ? ((periodChange / firstClose) * 100).toFixed(1) : "0.0"}%)
        </span>
      </p>
    </div>
  );
}
