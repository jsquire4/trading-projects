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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OptionsComparisonProps {
  ticker: string;
  markets: ParsedMarket[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ComparisonRow {
  strike: number;
  strikeLabel: string;
  optionsDelta: number | null;
  meridianPrice: number | null;
  marketKey: string | null;
}

// ---------------------------------------------------------------------------
// Helper: compute Meridian implied probability from N(d2) (Black-Scholes)
// ---------------------------------------------------------------------------

function useMeridianImpliedProb(
  markets: ParsedMarket[],
  spotPrice: number | null,
): Map<string, number | null> {
  return useMemo(() => {
    const prices = new Map<string, number | null>();
    if (spotPrice === null || spotPrice <= 0) {
      for (const m of markets) prices.set(m.publicKey.toBase58(), null);
      return prices;
    }

    const now = Date.now() / 1000;

    for (const m of markets) {
      const key = m.publicKey.toBase58();
      const strike = Number(m.strikePrice) / 1_000_000;
      const T = (Number(m.marketCloseUnix) - now) / SECONDS_PER_YEAR;

      if (T <= 0 || strike <= 0) {
        // Expired or invalid — use intrinsic
        prices.set(key, spotPrice >= strike ? 1 : 0);
        continue;
      }

      const d2Val = d2(spotPrice, strike, DEFAULT_SIGMA, T, RISK_FREE_RATE);
      prices.set(key, normalCdf(d2Val));
    }

    return prices;
  }, [markets, spotPrice]);
}

// ---------------------------------------------------------------------------
// Skeleton shimmer
// ---------------------------------------------------------------------------

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-5 w-48 rounded bg-white/10" />
      <div className="h-[320px] rounded-lg bg-white/5" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OptionsComparison({
  ticker,
  markets,
}: OptionsComparisonProps) {
  const {
    data: optionsChain,
    isLoading: optionsLoading,
  } = useTradierOptions(ticker);

  const { data: quotes } = useTradierQuotes([ticker]);
  const spotPrice = useMemo(() => {
    if (!quotes || quotes.length === 0) return null;
    const q = quotes.find((q) => q.symbol.toUpperCase() === ticker.toUpperCase());
    return q?.last ?? null;
  }, [quotes, ticker]);

  // Filter markets to this ticker
  const tickerMarkets = useMemo(
    () => markets.filter((m) => m.ticker.toUpperCase() === ticker.toUpperCase()),
    [markets, ticker],
  );

  const meridianPrices = useMeridianImpliedProb(tickerMarkets, spotPrice);

  // Build strike -> market lookup (strike in dollars)
  const strikeToMarket = useMemo(() => {
    const map = new Map<number, ParsedMarket>();
    for (const m of tickerMarkets) {
      const strikeDollars = Number(m.strikePrice) / 1_000_000;
      map.set(strikeDollars, m);
    }
    return map;
  }, [tickerMarkets]);

  // Build comparison data
  const chartData = useMemo(() => {
    if (!optionsChain) return [];

    // Only call options (delta ~ probability of finishing ITM)
    const calls = optionsChain.filter(
      (o) => o.option_type === "call" || o.type === "call",
    );

    // Collect all strikes from both sources
    const strikeSet = new Set<number>();
    for (const c of calls) strikeSet.add(c.strike);
    for (const [s] of strikeToMarket) strikeSet.add(s);

    const sorted = Array.from(strikeSet).sort((a, b) => a - b);

    const rows: ComparisonRow[] = sorted.map((strike) => {
      // Options delta
      const call = calls.find((c) => c.strike === strike);
      const delta = call?.greeks?.delta ?? null;

      // Meridian price
      const market = strikeToMarket.get(strike);
      const mPrice = market
        ? meridianPrices.get(market.publicKey.toBase58()) ?? null
        : null;

      return {
        strike,
        strikeLabel: formatDollar(strike),
        optionsDelta: delta,
        meridianPrice: mPrice,
        marketKey: market?.publicKey.toBase58() ?? null,
      };
    });

    return rows;
  }, [optionsChain, strikeToMarket, meridianPrices]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (optionsLoading) {
    return <Skeleton />;
  }

  if (!optionsChain || optionsChain.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
        <p className="text-sm text-white/50">
          Options data unavailable &mdash; no 0DTE expiration found for{" "}
          <span className="font-mono font-semibold text-white/70">{ticker}</span>.
          Options comparison requires same-day expiring contracts.
        </p>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
        <p className="text-sm text-white/50">
          No matching strike prices between options chain and Meridian markets
          for {ticker}.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-white/70">
        Options Delta vs Meridian N(d2) Implied Prob &mdash;{" "}
        <span className="font-mono text-white">{ticker}</span>
      </h3>

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
                String(name),
              ]}
              labelFormatter={(label: any) => `Strike: ${label}`}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}
            />
            <Bar
              dataKey="optionsDelta"
              name="Options Delta"
              fill={COLORS.accent}
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
            />
            <Bar
              dataKey="meridianPrice"
              name="Meridian N(d2)"
              fill={COLORS.yes}
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
