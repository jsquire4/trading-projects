"use client";

/**
 * HistoricalOverlay — Daily return distribution histogram with normal curve overlay.
 *
 * Fetches 1 year of OHLCV history from Tradier, computes daily (or weekly)
 * percentage returns, buckets them into a histogram, fits a normal distribution,
 * and projects forward from the current price using the mean return.
 */

import { useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

import { useTradierHistory } from "@/hooks/useAnalyticsData";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatDollar,
} from "@/lib/chartConfig";
import {
  computeReturns,
  toWeeklyCloses,
  mean,
  stddev,
  buildHistogram,
  type BucketRow,
} from "@/lib/distribution-math";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HistoricalOverlayProps {
  ticker: string;
  currentPrice?: number;
}

type Period = "daily" | "weekly";

// ---------------------------------------------------------------------------
// Extracted SVG tick renderer for the XAxis
// ---------------------------------------------------------------------------

interface RotatedXAxisTickProps {
  x?: number;
  y?: number;
  payload?: { value: string };
  chartData: BucketRow[];
}

function RotatedXAxisTick({ x, y, payload, chartData }: RotatedXAxisTickProps) {
  const row = chartData.find((d) => d.label === payload?.value);
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text
        dy={12}
        textAnchor="middle"
        fill={COLORS.axisText}
        fontSize={11}
        fontFamily="ui-monospace, monospace"
      >
        {payload?.value}
      </text>
      {row && (
        <text
          dy={24}
          textAnchor="middle"
          fill="rgba(255,255,255,0.25)"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
        >
          {row.sigmaLabel}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoricalOverlay({
  ticker,
  currentPrice,
}: HistoricalOverlayProps) {
  const [period, setPeriod] = useState<Period>("daily");
  const { data: history, isLoading, isError } = useTradierHistory(ticker, 365);

  // Compute returns
  const returns = useMemo(() => {
    if (!history || history.length < 2) return [];
    const closes = history.map((bar) => bar.close);
    if (period === "weekly") {
      return computeReturns(toWeeklyCloses(closes));
    }
    return computeReturns(closes);
  }, [history, period]);

  const mu = useMemo(() => mean(returns), [returns]);
  const sigma = useMemo(() => stddev(returns, mu), [returns, mu]);

  // Histogram
  const binWidth = period === "daily" ? 0.25 : 1.0;
  const chartData = useMemo(
    () => buildHistogram(returns, binWidth),
    [returns, binWidth],
  );

  // Forward projection
  const projection = useMemo(() => {
    if (!currentPrice || currentPrice <= 0 || returns.length === 0) return null;

    const periodsPerWeek = period === "daily" ? 5 : 1;
    const periodsPerMonth = period === "daily" ? 21 : 4;
    const periodsPerYear = period === "daily" ? 252 : 52;

    // Compound the mean return forward
    const weekPrice = currentPrice * (1 + mu / 100) ** periodsPerWeek;
    const monthPrice = currentPrice * (1 + mu / 100) ** periodsPerMonth;
    const yearPrice = currentPrice * (1 + mu / 100) ** periodsPerYear;

    // Annualized return
    const annualizedPct = ((1 + mu / 100) ** periodsPerYear - 1) * 100;

    return { weekPrice, monthPrice, yearPrice, annualizedPct };
  }, [currentPrice, mu, period, returns.length]);

  // Date labels for projection
  const dates = useMemo(() => {
    const now = new Date();
    const week = new Date(now);
    week.setDate(week.getDate() + 7);
    const month = new Date(now);
    month.setMonth(month.getMonth() + 1);
    const year = new Date(now);
    year.setFullYear(year.getFullYear() + 1);
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return { week: fmt(week), month: fmt(month), year: fmt(year) };
  }, []);

  // ---------------------------------------------------------------------------
  // Edge-case renders
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Loading historical data for {ticker}...
      </div>
    );
  }

  if (isError || !history || history.length < 10) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Historical data unavailable for {ticker}
      </div>
    );
  }

  if (returns.length < 5) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Insufficient data to compute return distribution
      </div>
    );
  }

  const periodLabel = period === "daily" ? "1-day" : "1-week";

  return (
    <div className="w-full space-y-3">
      {/* Period toggle */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">
          {period === "daily" ? "Daily" : "Weekly"} Return Distribution
        </h3>
        <div className="flex gap-1 bg-white/5 rounded p-0.5">
          {(["daily", "weekly"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                p === period
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/60"
              }`}
            >
              {p === "daily" ? "Daily" : "Weekly"}
            </button>
          ))}
        </div>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
          <p className="text-[10px] text-white/40">Mean {periodLabel} return (&#956;)</p>
          <p className={`text-lg font-bold tabular-nums ${mu >= 0 ? "text-green-400" : "text-red-400"}`}>
            {mu >= 0 ? "+" : ""}{mu.toFixed(3)}%
          </p>
          <p className="text-[10px] text-white/25 tabular-nums">&#956; = {mu.toFixed(4)}</p>
        </div>
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
          <p className="text-[10px] text-white/40">Std deviation (&#963;)</p>
          <p className="text-lg font-bold tabular-nums text-white/80">
            {sigma.toFixed(3)}%
          </p>
          <p className="text-[10px] text-white/25 tabular-nums">&#963; = {sigma.toFixed(4)}</p>
        </div>
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
          <p className="text-[10px] text-white/40">Observations (n)</p>
          <p className="text-lg font-bold tabular-nums text-white/80">
            {returns.length}
          </p>
          <p className="text-[10px] text-white/25 tabular-nums">&#956; &#177; 1&#963; = [{(mu - sigma).toFixed(2)}%, {(mu + sigma).toFixed(2)}%]</p>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart
          data={chartData}
          margin={{ top: 20, right: 16, bottom: 4, left: 8 }}
        >
          <CartesianGrid {...GRID_STYLE} />

          <XAxis
            dataKey="label"
            tick={(props: any) => <RotatedXAxisTick {...props} chartData={chartData} />}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={35}
            height={40}
          />

          <YAxis
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15)]}
            tickFormatter={(v: number) => `${v}%`}
            width={42}
          />

          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value: unknown, name: unknown) => [
              `${Number(value).toFixed(1)}%`,
              name === "frequency" ? "Observed" : "Normal Fit",
            ]}
            labelFormatter={(label: unknown) => `Return: ${String(label)}`}
          />

          <ReferenceLine
            x={chartData.find((d) => d.center >= 0 && d.center < binWidth)?.label}
            stroke={COLORS.neutral}
            strokeDasharray="4 4"
            label={{ value: "0%", fill: COLORS.axisText, fontSize: 10, position: "top" }}
          />

          <Bar
            dataKey="frequency"
            fill={COLORS.accent}
            opacity={0.7}
            radius={[2, 2, 0, 0]}
            name="frequency"
          />

          <Line
            dataKey="normal"
            stroke={COLORS.secondary}
            strokeWidth={2}
            dot={false}
            name="normal"
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Projection */}
      {projection && currentPrice && currentPrice > 0 && (
        <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-1.5">
          <p className="text-xs text-white/50 font-medium">
            Forward projection at mean {periodLabel} return of{" "}
            <span className={mu >= 0 ? "text-green-400" : "text-red-400"}>
              {mu >= 0 ? "+" : ""}{mu.toFixed(3)}%
            </span>{" "}
            from {formatDollar(currentPrice)} today:
          </p>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-white/40 text-xs">1 week</span>
              <p className="font-mono font-medium text-white/80">
                {formatDollar(projection.weekPrice)}
              </p>
              <p className="text-[10px] text-white/30">{dates.week}</p>
            </div>
            <div>
              <span className="text-white/40 text-xs">1 month</span>
              <p className="font-mono font-medium text-white/80">
                {formatDollar(projection.monthPrice)}
              </p>
              <p className="text-[10px] text-white/30">{dates.month}</p>
            </div>
            <div>
              <span className="text-white/40 text-xs">1 year</span>
              <p className="font-mono font-medium text-white/80">
                {formatDollar(projection.yearPrice)}
              </p>
              <p className="text-[10px] text-white/30">{dates.year}</p>
            </div>
          </div>
          <p className="text-[10px] text-white/25">
            Annualized: {projection.annualizedPct >= 0 ? "+" : ""}{projection.annualizedPct.toFixed(1)}%.
            {" "}Based on {returns.length} {periodLabel} observations. Past performance is not indicative of future results.
          </p>
        </div>
      )}

      <p className="text-[10px] text-zinc-600">
        {returns.length} {period} returns over ~{Math.round(returns.length * (period === "daily" ? 1 : 5) / 252 * 12)} months.
        {" "}Purple curve: fitted normal distribution (μ={mu.toFixed(3)}%, σ={sigma.toFixed(3)}%).
      </p>
    </div>
  );
}
