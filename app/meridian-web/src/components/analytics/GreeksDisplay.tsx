"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

import { ParsedMarket } from "@/hooks/useMarkets";
import { useTradierQuotes } from "@/hooks/useAnalyticsData";
import { binaryDelta, binaryGamma, d2, normalCdf } from "@/lib/greeks";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatPercent,
} from "@/lib/chartConfig";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SIGMA =
  parseFloat(process.env.NEXT_PUBLIC_DEFAULT_VOL ?? "") || 0.3;
const RISK_FREE_RATE = 0.05;
const SECONDS_PER_YEAR = 365.25 * 86400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GreeksRow {
  strike: number;
  delta: number;
  gamma: number;
  impliedProb: number;
}

function computeGreeks(
  markets: ParsedMarket[],
  spotPrice: number,
): GreeksRow[] {
  const now = Date.now() / 1000;

  return markets
    .map((m) => {
      const strike = Number(m.strikePrice) / 1_000_000;
      const T = (Number(m.marketCloseUnix) - now) / SECONDS_PER_YEAR;

      if (T <= 0) {
        // Expired market — delta/gamma collapse to zero, implied prob is
        // either 1 (ITM) or 0 (OTM).
        return {
          strike,
          delta: 0,
          gamma: 0,
          impliedProb: spotPrice >= strike ? 1 : 0,
        };
      }

      const delta = binaryDelta(spotPrice, strike, DEFAULT_SIGMA, T, RISK_FREE_RATE);
      const gamma = binaryGamma(spotPrice, strike, DEFAULT_SIGMA, T, RISK_FREE_RATE);
      const d2Val = d2(spotPrice, strike, DEFAULT_SIGMA, T, RISK_FREE_RATE);
      const impliedProb = normalCdf(d2Val);

      return { strike, delta, gamma, impliedProb };
    })
    .sort((a, b) => a.strike - b.strike);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DeltaCell({ value }: { value: number }) {
  // Green gradient based on delta magnitude (positive = ITM direction)
  const intensity = Math.min(Math.abs(value) * 300, 1);
  const bg =
    value >= 0
      ? `rgba(34, 197, 94, ${intensity * 0.25})`
      : `rgba(239, 68, 68, ${intensity * 0.25})`;

  return (
    <td className="px-3 py-2 text-right font-mono text-sm" style={{ backgroundColor: bg }}>
      {value.toFixed(4)}
    </td>
  );
}

function GammaCell({ value, maxGamma }: { value: number; maxGamma: number }) {
  // Purple gradient — peak near ATM
  const intensity = maxGamma > 0 ? Math.abs(value) / maxGamma : 0;
  const bg = `rgba(168, 85, 247, ${intensity * 0.3})`;

  return (
    <td className="px-3 py-2 text-right font-mono text-sm" style={{ backgroundColor: bg }}>
      {value.toFixed(4)}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface GreeksDisplayProps {
  ticker: string;
  markets: ParsedMarket[];
}

export function GreeksDisplay({ ticker, markets }: GreeksDisplayProps) {
  const { data: quotes, isLoading: quotesLoading } = useTradierQuotes([ticker]);

  const spotPrice = useMemo(() => {
    if (!quotes || quotes.length === 0) return null;
    const q = quotes.find((q) => q.symbol.toUpperCase() === ticker.toUpperCase());
    return q?.last ?? null;
  }, [quotes, ticker]);

  const rows = useMemo(() => {
    if (spotPrice === null || markets.length === 0) return [];
    return computeGreeks(markets, spotPrice);
  }, [markets, spotPrice]);

  const maxGamma = useMemo(
    () => rows.reduce((max, r) => Math.max(max, Math.abs(r.gamma)), 0),
    [rows],
  );

  // Determine whether dual Y axes are needed (scales differ by 5x+)
  const needsDualAxis = useMemo(() => {
    if (rows.length === 0) return false;
    const maxDelta = Math.max(...rows.map((r) => Math.abs(r.delta)), 0.0001);
    const maxG = Math.max(...rows.map((r) => Math.abs(r.gamma)), 0.0001);
    return maxDelta / maxG > 5 || maxG / maxDelta > 5;
  }, [rows]);

  // ------ Edge cases ------

  if (markets.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-500">
        No markets available for {ticker}.
      </div>
    );
  }

  if (quotesLoading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
          Loading quote data for {ticker}...
        </div>
      </div>
    );
  }

  if (spotPrice === null) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-yellow-500">
        No quote data available for {ticker}. Greeks cannot be computed without a live price.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-500">
        No greek data to display.
      </div>
    );
  }

  // ------ Render ------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold text-white">
          Binary Greeks — {ticker}
        </h3>
        <span className="text-xs text-gray-500">
          Spot ${spotPrice.toFixed(2)} &middot; &sigma; = {(DEFAULT_SIGMA * 100).toFixed(0)}%
          &middot; r = {(RISK_FREE_RATE * 100).toFixed(1)}%
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="px-3 py-2 text-left font-medium text-gray-400">Strike</th>
              <th className="px-3 py-2 text-right font-medium text-gray-400">Delta</th>
              <th className="px-3 py-2 text-right font-medium text-gray-400">Gamma</th>
              <th className="px-3 py-2 text-right font-medium text-gray-400">Implied Prob</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.strike}
                className="border-b border-white/5 transition-colors hover:bg-white/[0.04]"
              >
                <td className="px-3 py-2 font-mono text-sm text-white">
                  ${row.strike.toFixed(2)}
                </td>
                <DeltaCell value={row.delta} />
                <GammaCell value={row.gamma} maxGamma={maxGamma} />
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-300">
                  {formatPercent(row.impliedProb)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Chart */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={rows} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis
              dataKey="strike"
              tick={AXIS_STYLE}
              tickFormatter={(v: number) => `$${v}`}
              label={{
                value: "Strike",
                position: "insideBottomRight",
                offset: -5,
                style: { ...AXIS_STYLE, fontSize: 10 },
              }}
            />

            {/* Left Y axis — Delta */}
            <YAxis
              yAxisId="delta"
              orientation="left"
              tick={AXIS_STYLE}
              tickFormatter={(v: number) => v.toFixed(3)}
              label={{
                value: "Delta",
                angle: -90,
                position: "insideLeft",
                style: { ...AXIS_STYLE, fill: COLORS.accent, fontSize: 10 },
              }}
            />

            {/* Right Y axis — Gamma (only when scales differ) */}
            {needsDualAxis && (
              <YAxis
                yAxisId="gamma"
                orientation="right"
                tick={AXIS_STYLE}
                tickFormatter={(v: number) => v.toFixed(3)}
                label={{
                  value: "Gamma",
                  angle: 90,
                  position: "insideRight",
                  style: { ...AXIS_STYLE, fill: COLORS.secondary, fontSize: 10 },
                }}
              />
            )}

            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value: any, name: any) => [
                Number(value).toFixed(5),
                String(name),
              ]}
              labelFormatter={(label: any) => `Strike: $${label}`}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: COLORS.axisText }}
            />

            <Line
              yAxisId="delta"
              type="monotone"
              dataKey="delta"
              name="Delta"
              stroke={COLORS.accent}
              strokeWidth={2}
              dot={{ r: 3, fill: COLORS.accent }}
              activeDot={{ r: 5 }}
            />
            <Line
              yAxisId={needsDualAxis ? "gamma" : "delta"}
              type="monotone"
              dataKey="gamma"
              name="Gamma"
              stroke={COLORS.secondary}
              strokeWidth={2}
              dot={{ r: 3, fill: COLORS.secondary }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
