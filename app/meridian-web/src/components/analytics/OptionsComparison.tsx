"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useTradierOptions, useTradierQuotes } from "@/hooks/useAnalyticsData";
import type { ParsedMarket } from "@/hooks/useMarkets";
import { d2, normalCdf } from "@/lib/greeks";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatPercent,
  formatDollar,
} from "@/lib/chartConfig";

const _parsedVol = parseFloat(process.env.NEXT_PUBLIC_DEFAULT_VOL ?? "");
const DEFAULT_SIGMA = Number.isFinite(_parsedVol) && _parsedVol > 0 ? _parsedVol : 0.3;
const RISK_FREE_RATE = 0.05;
const SECONDS_PER_YEAR = 365.25 * 86400;

interface OptionsComparisonProps {
  ticker: string;
  markets: ParsedMarket[];
}

interface ComparisonRow {
  strike: number;
  strikeLabel: string;
  optionsDelta: number | null;
  bsProb: number | null;
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-5 w-48 rounded bg-white/10" />
      <div className="h-[320px] rounded-lg bg-white/5" />
    </div>
  );
}

export function OptionsComparison({
  ticker,
  markets,
}: OptionsComparisonProps) {
  const {
    data: optionsResult,
    isLoading: optionsLoading,
  } = useTradierOptions(ticker);
  const optionsChain = optionsResult?.chain ?? null;
  const optionsExpiration = optionsResult?.expiration ?? null;

  const { data: quotes } = useTradierQuotes([ticker]);
  const spotPrice = useMemo(() => {
    if (!quotes || quotes.length === 0) return null;
    const q = quotes.find((q) => q.symbol.toUpperCase() === ticker.toUpperCase());
    return q?.last ?? null;
  }, [quotes, ticker]);

  // Compute time-to-expiry in years for Black-Scholes
  const timeToExpiry = useMemo(() => {
    if (!optionsExpiration) return 1 / 365.25; // default 1 day
    const expDate = new Date(optionsExpiration + "T16:00:00-04:00"); // 4 PM ET close
    const now = new Date();
    const diffSec = (expDate.getTime() - now.getTime()) / 1000;
    return Math.max(diffSec / SECONDS_PER_YEAR, 1 / (365.25 * 24 * 60)); // floor at 1 minute
  }, [optionsExpiration]);

  // Build comparison data — always compute N(d2) from spot + strike (no on-chain markets needed)
  const chartData = useMemo(() => {
    if (!optionsChain || !spotPrice || spotPrice <= 0) return [];

    const calls = optionsChain.filter(
      (o) => o.option_type === "call" || o.type === "call",
    );
    if (calls.length === 0) return [];

    // Filter to strikes within ±15% of spot for readability
    const lo = spotPrice * 0.85;
    const hi = spotPrice * 1.15;
    const nearATM = calls
      .filter((c) => c.strike >= lo && c.strike <= hi)
      .sort((a, b) => a.strike - b.strike);

    // Use IV from the option if available, otherwise fall back to DEFAULT_SIGMA
    return nearATM.map((call) => {
      const delta = call.greeks?.delta ?? null;
      const sigma = call.greeks?.mid_iv && call.greeks.mid_iv > 0
        ? call.greeks.mid_iv
        : DEFAULT_SIGMA;

      const d2Val = d2(spotPrice, call.strike, sigma, timeToExpiry, RISK_FREE_RATE);
      const bsProb = normalCdf(d2Val);

      return {
        strike: call.strike,
        strikeLabel: formatDollar(call.strike),
        optionsDelta: delta,
        bsProb: Math.round(bsProb * 1000) / 1000,
      };
    });
  }, [optionsChain, spotPrice, timeToExpiry]);

  if (optionsLoading) {
    return <Skeleton />;
  }

  if (!optionsChain || optionsChain.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
        <p className="text-sm text-white/50">
          No options data available for{" "}
          <span className="font-mono font-semibold text-white/70">{ticker}</span>.
        </p>
      </div>
    );
  }

  const isToday = optionsExpiration === new Date().toISOString().split("T")[0];
  const expirationLabel = optionsExpiration
    ? new Date(optionsExpiration + "T12:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
        <p className="text-sm text-white/50">
          No strike data near current price for {ticker}.
        </p>
      </div>
    );
  }

  // Find ATM strike (closest to spot)
  const atmStrike = spotPrice
    ? chartData.reduce((best, row) =>
        Math.abs(row.strike - spotPrice) < Math.abs(best.strike - spotPrice)
          ? row
          : best,
      ).strikeLabel
    : null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-white/70">
          Market Delta vs Black-Scholes N(d2) &mdash;{" "}
          <span className="font-mono text-white">{ticker}</span>
          {expirationLabel && (
            <span className="ml-2 text-xs text-white/40">
              ({isToday ? "0DTE" : `exp ${expirationLabel}`})
            </span>
          )}
        </h3>
        <p className="text-xs text-white/30 mt-1">
          Compares the real options market&apos;s implied probability (call delta from Tradier)
          against the theoretical Black-Scholes probability N(d2) that {ticker} finishes above each strike.
          Divergence reveals where the market prices risk differently than the model.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={chartData}
            margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid {...GRID_STYLE} />
            <XAxis
              dataKey="strikeLabel"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={{ stroke: COLORS.grid }}
              interval="preserveStartEnd"
              minTickGap={30}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={formatPercent}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={{ stroke: COLORS.grid }}
              width={52}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value: any, name: any) => [
                formatPercent(Number(value)),
                name === "optionsDelta" ? "Market Delta" : "Black-Scholes N(d2)",
              ]}
              labelFormatter={(label: any) => `Strike: ${label}`}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}
              formatter={(value: string) =>
                value === "optionsDelta" ? "Market Delta" : "Black-Scholes N(d2)"
              }
            />
            {atmStrike && (
              <ReferenceLine
                x={atmStrike}
                stroke={COLORS.neutral}
                strokeDasharray="4 4"
                label={{ value: "ATM", fill: COLORS.axisText, fontSize: 10, position: "top" }}
              />
            )}
            <Bar
              dataKey="optionsDelta"
              name="optionsDelta"
              fill={COLORS.accent}
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
            />
            <Bar
              dataKey="bsProb"
              name="bsProb"
              fill={COLORS.yes}
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-zinc-600">
        Strikes within &plusmn;15% of spot ({spotPrice ? formatDollar(spotPrice) : "—"}).
        {" "}N(d2) uses {isToday ? "0DTE" : "time-to-expiry"} and per-strike implied vol when available.
      </p>
    </div>
  );
}
