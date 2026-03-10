"use client";

/**
 * GreeksDisplay — Shows options Greeks from Tradier chain data.
 * Table + chart of delta/gamma across strikes near ATM.
 * No on-chain markets required.
 */

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
  ReferenceLine,
} from "recharts";
import { useTradierOptions, useTradierQuotes } from "@/hooks/useAnalyticsData";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatDollar,
} from "@/lib/chartConfig";
import { InsightTooltip } from "@/components/InsightTooltip";
import { interpretDelta, interpretGamma } from "@/lib/insights";

interface GreeksDisplayProps {
  ticker: string;
  markets?: unknown[]; // kept for backwards compat, unused
}

interface GreeksRow {
  strike: number;
  strikeLabel: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export function GreeksDisplay({ ticker }: GreeksDisplayProps) {
  const { data: optionsResult, isLoading } = useTradierOptions(ticker);
  const { data: quotes } = useTradierQuotes([ticker]);

  const optionsChain = optionsResult?.chain ?? null;
  const expiration = optionsResult?.expiration ?? null;

  const spotPrice = useMemo(() => {
    if (!quotes || quotes.length === 0) return null;
    const q = quotes.find((q) => q.symbol.toUpperCase() === ticker.toUpperCase());
    return q?.last ?? null;
  }, [quotes, ticker]);

  const rows = useMemo(() => {
    if (!optionsChain || !spotPrice || spotPrice <= 0) return [];

    const lo = spotPrice * 0.90;
    const hi = spotPrice * 1.10;

    return optionsChain
      .filter(
        (o) =>
          (o.option_type === "call" || o.type === "call") &&
          o.strike >= lo &&
          o.strike <= hi &&
          o.greeks,
      )
      .sort((a, b) => a.strike - b.strike)
      .map((o) => ({
        strike: o.strike,
        strikeLabel: `$${o.strike.toFixed(0)}`,
        delta: o.greeks!.delta,
        gamma: o.greeks!.gamma,
        theta: o.greeks!.theta,
        vega: o.greeks!.vega,
        iv: o.greeks!.mid_iv ?? 0,
      }));
  }, [optionsChain, spotPrice]);

  const maxGamma = useMemo(
    () => rows.reduce((max, r) => Math.max(max, Math.abs(r.gamma)), 0),
    [rows],
  );

  const atmStrike = useMemo(() => {
    if (!spotPrice || rows.length === 0) return null;
    return rows.reduce((best, r) =>
      Math.abs(r.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? r : best,
    ).strikeLabel;
  }, [rows, spotPrice]);

  const needsDualAxis = useMemo(() => {
    if (rows.length === 0) return false;
    const maxDelta = Math.max(...rows.map((r) => Math.abs(r.delta)), 0.0001);
    const maxG = Math.max(...rows.map((r) => Math.abs(r.gamma)), 0.0001);
    return maxDelta / maxG > 5 || maxG / maxDelta > 5;
  }, [rows]);

  const isToday = expiration === new Date().toISOString().split("T")[0];
  const expirationLabel = expiration
    ? new Date(expiration + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-5 w-40 rounded bg-white/10" />
        <div className="h-64 rounded bg-white/5" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-white/50">
        No Greeks data available for {ticker}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-white/40">
          Call Greeks near ATM ({spotPrice ? formatDollar(spotPrice) : ""})
          {expirationLabel && ` | ${isToday ? "0DTE" : expirationLabel}`}
        </p>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="px-3 py-2 text-left font-medium text-white/40">Strike</th>
              <th className="px-3 py-2 text-right font-medium text-white/40">Delta</th>
              <th className="px-3 py-2 text-right font-medium text-white/40">Gamma</th>
              <th className="px-3 py-2 text-right font-medium text-white/40">Theta</th>
              <th className="px-3 py-2 text-right font-medium text-white/40">Vega</th>
              <th className="px-3 py-2 text-right font-medium text-white/40">IV</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isATM = row.strikeLabel === atmStrike;
              const isITM = spotPrice ? row.strike < spotPrice : false;
              // Delta heat: green intensity proportional to delta
              const deltaIntensity = Math.min(Math.abs(row.delta) * 300, 1);
              const deltaBg = `rgba(34, 197, 94, ${deltaIntensity * 0.2})`;
              // Gamma heat: purple intensity proportional to gamma
              const gammaIntensity = maxGamma > 0 ? Math.abs(row.gamma) / maxGamma : 0;
              const gammaBg = `rgba(168, 85, 247, ${gammaIntensity * 0.25})`;

              return (
                <tr
                  key={row.strike}
                  className={`border-b border-white/5 transition-colors hover:bg-white/[0.04] ${
                    isATM ? "bg-white/[0.06]" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono text-white">
                    {row.strikeLabel}
                    {isATM && <span className="ml-1 text-[9px] text-white/40">ATM</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-white/70" style={{ backgroundColor: deltaBg }}>
                    <InsightTooltip insight={interpretDelta(row.delta, ticker, row.strike)}>
                      {row.delta.toFixed(4)}
                    </InsightTooltip>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-white/70" style={{ backgroundColor: gammaBg }}>
                    <InsightTooltip insight={interpretGamma(row.gamma, ticker)}>
                      {row.gamma.toFixed(4)}
                    </InsightTooltip>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-red-400/70">
                    {row.theta.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-white/60">
                    {row.vega.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-white/50">
                    {row.iv > 0 ? `${(row.iv * 100).toFixed(0)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis
              dataKey="strikeLabel"
              tick={AXIS_STYLE}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={30}
            />
            <YAxis
              yAxisId="delta"
              orientation="left"
              tick={AXIS_STYLE}
              tickLine={false}
              tickFormatter={(v: number) => v.toFixed(2)}
              width={40}
            />
            {needsDualAxis && (
              <YAxis
                yAxisId="gamma"
                orientation="right"
                tick={AXIS_STYLE}
                tickLine={false}
                tickFormatter={(v: number) => v.toFixed(4)}
                width={48}
              />
            )}
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value: any, name: any) => [
                Number(value).toFixed(5),
                String(name),
              ]}
              labelFormatter={(label: any) => `Strike: ${label}`}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: COLORS.axisText }} />
            {atmStrike && (
              <ReferenceLine
                x={atmStrike}
                yAxisId="delta"
                stroke={COLORS.neutral}
                strokeDasharray="4 4"
                label={{ value: "ATM", fill: COLORS.axisText, fontSize: 9, position: "top" }}
              />
            )}
            <Line
              yAxisId="delta"
              type="monotone"
              dataKey="delta"
              name="Delta"
              stroke={COLORS.accent}
              strokeWidth={2}
              dot={{ r: 2, fill: COLORS.accent }}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId={needsDualAxis ? "gamma" : "delta"}
              type="monotone"
              dataKey="gamma"
              name="Gamma"
              stroke={COLORS.secondary}
              strokeWidth={2}
              dot={{ r: 2, fill: COLORS.secondary }}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-white/20">
        Delta ~ probability of finishing ITM. Gamma peaks at ATM. Theta is daily time decay (negative = cost to hold). All values from Tradier options chain.
      </p>
    </div>
  );
}
