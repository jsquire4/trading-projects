"use client";

/**
 * HistoricalOverlay — 252-day daily return distribution vs. Meridian implied probabilities.
 *
 * Fetches 365 calendar days of OHLCV history from Tradier, computes daily log
 * returns, buckets them by strike price, and overlays the historical frequency
 * against the current Yes token prices from the on-chain order books.
 */

import { useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

import type { ParsedMarket } from "@/hooks/useMarkets";
import { useTradierHistory } from "@/hooks/useAnalyticsData";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatDollar,
} from "@/lib/chartConfig";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HistoricalOverlayProps {
  /** Stock ticker symbol */
  ticker: string;
  /** Meridian markets for this ticker (one per strike) */
  markets: ParsedMarket[];
  /** Current stock price in dollars — used to compute required return per strike */
  currentPrice?: number;
  /**
   * Yes token mid-price for each strike (dollars → cents 0-100).
   * If not supplied the line series is omitted.
   *
   * Note: Map keys are floating-point dollar amounts. Lookup relies on exact
   * float equality which can miss matches for fractional strikes. This is
   * acceptable for now since all strikes are whole-dollar integers (#22).
   */
  yesPrices?: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert ParsedMarket.strikePrice (USDC lamports, 6 decimals) to dollars. */
function strikeToDollars(raw: bigint): number {
  return Number(raw) / 1_000_000;
}

/** Compute daily log returns from an array of closing prices. */
function computeLogReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return returns;
}

/**
 * For a given strike and current price, compute what daily log return would
 * bring the current price to that strike level.
 * Guards against strike <= 0 which would produce NaN from Math.log (#11).
 */
function requiredReturn(currentPrice: number, strike: number): number {
  if (currentPrice <= 0 || strike <= 0) return 0;
  return Math.log(strike / currentPrice);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoricalOverlay({
  ticker,
  markets,
  currentPrice,
  yesPrices,
}: HistoricalOverlayProps) {
  const { data: history, isLoading, isError } = useTradierHistory(ticker, 365);

  // Sorted unique strike prices in dollars
  const strikes = useMemo(() => {
    const raw = markets.map((m) => strikeToDollars(m.strikePrice));
    return [...new Set(raw)].sort((a, b) => a - b);
  }, [markets]);

  // Daily log returns (up to ~252 trading days from 365 calendar days)
  const logReturns = useMemo(() => {
    if (!history || history.length < 2) return [];
    const closes = history.map((bar) => bar.close);
    return computeLogReturns(closes);
  }, [history]);

  // Half-bin width: half the minimum gap between consecutive strikes.
  // Falls back to 0.5% of the first strike if only one strike exists.
  const halfBin = useMemo(() => {
    if (strikes.length < 2) {
      return strikes.length === 1 ? strikes[0] * 0.005 : 0.01;
    }
    let minGap = Infinity;
    for (let i = 1; i < strikes.length; i++) {
      minGap = Math.min(minGap, strikes[i] - strikes[i - 1]);
    }
    return minGap / 2;
  }, [strikes]);

  // Chart data: one row per strike
  const chartData = useMemo(() => {
    if (strikes.length === 0 || !currentPrice || currentPrice <= 0) return [];
    const n = logReturns.length;
    if (n === 0) return [];

    return strikes.map((strike) => {
      // Bin edges in return space: the log return needed to reach (strike +/- halfBin)
      // Clamp lower edge to avoid Math.log of zero or negative (#11)
      const loReturn = requiredReturn(currentPrice, Math.max(0.01, strike - halfBin));
      const hiReturn = requiredReturn(currentPrice, strike + halfBin);
      const binLo = Math.min(loReturn, hiReturn);
      const binHi = Math.max(loReturn, hiReturn);

      const count = logReturns.filter((r) => r >= binLo && r < binHi).length;
      const historicalPct = n > 0 ? (count / n) * 100 : 0;

      // Yes token price (cents 0–100) → treat as probability percentage
      const yesPrice = yesPrices?.get(strike) ?? undefined;

      return {
        strike,
        strikeLabel: formatDollar(strike),
        historical: Math.round(historicalPct * 10) / 10,
        ...(yesPrice !== undefined ? { implied: yesPrice } : {}),
      };
    });
  }, [strikes, currentPrice, logReturns, halfBin, yesPrices]);

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

  if (isError || !history) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Historical data unavailable for {ticker}
      </div>
    );
  }

  if (history.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Historical data unavailable for {ticker}
      </div>
    );
  }

  const tradingDays = logReturns.length;

  if (!currentPrice || currentPrice <= 0) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-500">
        Current price unavailable — cannot compute return distribution
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="w-full space-y-2">
      <h3 className="text-sm font-medium text-zinc-300">
        Historical Return Distribution vs. Implied Probability
      </h3>

      {tradingDays < 60 && (
        <p className="text-xs text-amber-400">
          Limited data — {tradingDays} trading day{tradingDays !== 1 ? "s" : ""}{" "}
          available (60+ recommended for reliable distribution)
        </p>
      )}

      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
        >
          <CartesianGrid {...GRID_STYLE} />

          <XAxis
            dataKey="strikeLabel"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
          />

          <YAxis
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
          />

          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value: unknown, name: unknown) => [
              `${Number(value).toFixed(1)}%`,
              name === "historical"
                ? "Historical Frequency"
                : "Implied Probability",
            ]}
            labelFormatter={(label: unknown) => `Strike: ${String(label)}`}
          />

          <Legend
            wrapperStyle={{ fontSize: 11, color: COLORS.axisText }}
            formatter={(value: string) =>
              value === "historical"
                ? "Historical Frequency"
                : "Implied Probability (Yes Price)"
            }
          />

          <Bar
            dataKey="historical"
            fill={COLORS.secondary}
            opacity={0.7}
            radius={[3, 3, 0, 0]}
            name="historical"
          />

          {yesPrices && yesPrices.size > 0 && (
            <Line
              dataKey="implied"
              stroke={COLORS.yes}
              strokeWidth={2}
              dot={{ fill: COLORS.yes, r: 4 }}
              activeDot={{ r: 6 }}
              name="implied"
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-[10px] text-zinc-600">
        Based on {tradingDays} trading days of daily log returns.{" "}
        Current price: {formatDollar(currentPrice)}.
      </p>
    </div>
  );
}
