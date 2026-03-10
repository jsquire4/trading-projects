"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { usePortfolioSnapshot } from "@/hooks/usePortfolioSnapshot";
import { useCostBasis } from "@/hooks/useCostBasis";
import { usePositions } from "@/hooks/usePositions";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatDollar,
} from "@/lib/chartConfig";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPnl(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}${formatDollar(val)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

interface CardProps {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

function SummaryCard({ label, value, sub, color }: CardProps) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-white/40 text-xs font-medium uppercase tracking-wide">
        {label}
      </span>
      <span
        className="text-xl font-bold font-mono"
        style={{ color: color ?? "white" }}
      >
        {value}
      </span>
      {sub && <span className="text-white/40 text-xs">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={TOOLTIP_STYLE.contentStyle}
      className="px-3 py-2 rounded-lg text-xs"
    >
      <div style={TOOLTIP_STYLE.labelStyle}>{label != null ? fmtTime(label) : ""}</div>
      <div style={{ color: "white" }}>{payload[0].value != null ? formatDollar(payload[0].value) : "—"}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PnlTab() {
  const {
    intradayData,
    dailySummaries,
    todayPnl,
    currentValue,
    topPerformer,
    bottomPerformer,
    isReady,
  } = usePortfolioSnapshot();

  const { costBasis } = useCostBasis();
  const { data: positions = [] } = usePositions();

  const isPositive = todayPnl >= 0;
  const chartColor = isPositive ? COLORS.yes : COLORS.no;

  // Downsample intraday data to ~200 points for rendering performance
  const chartData =
    intradayData.length > 0
      ? intradayData.filter(
          (_, i) =>
            i % Math.max(1, Math.floor(intradayData.length / 200)) === 0 ||
            i === intradayData.length - 1,
        )
      : [];

  // Build per-position rows
  const positionRows = positions.map((pos) => {
    const marketKey = pos.market.publicKey.toBase58();
    const cb = costBasis.get(marketKey);

    const yesBal = Number(pos.yesBal) / 1_000_000;
    const noBal = Number(pos.noBal) / 1_000_000;

    // Rough current value at 50c mid (same as snapshot hook)
    const currentVal = (yesBal + noBal) * 0.5;

    const totalCost = cb ? cb.totalCostUsdc : 0;
    const pnl = currentVal - totalCost;
    const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
    const avgCost = cb ? cb.avgPrice : null; // in cents

    const side = yesBal > 0 && noBal > 0 ? "Yes + No" : yesBal > 0 ? "Yes" : "No";
    const qty = side === "Yes + No" ? yesBal + noBal : yesBal > 0 ? yesBal : noBal;

    return {
      marketKey,
      ticker: pos.market.ticker,
      side,
      qty,
      avgCost,
      currentVal,
      pnl,
      pnlPct,
    };
  });

  // Empty state — no data yet
  if (isReady && intradayData.length === 0 && positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <div className="w-14 h-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl">
          📈
        </div>
        <p className="text-white/50 text-sm">
          Start trading to see your performance.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          label="Today's P&L"
          value={isReady ? fmtPnl(todayPnl) : "—"}
          color={
            !isReady
              ? COLORS.axisText
              : todayPnl > 0
              ? COLORS.yes
              : todayPnl < 0
              ? COLORS.no
              : "white"
          }
        />
        <SummaryCard
          label="Current Value"
          value={isReady ? formatDollar(currentValue) : "—"}
        />
        <SummaryCard
          label="Top Performer"
          value={topPerformer ? fmtPnl(topPerformer.pnl) : "—"}
          sub={topPerformer?.ticker}
          color={topPerformer && topPerformer.pnl >= 0 ? COLORS.yes : COLORS.no}
        />
        <SummaryCard
          label="Bottom Performer"
          value={bottomPerformer ? fmtPnl(bottomPerformer.pnl) : "—"}
          sub={bottomPerformer?.ticker}
          color={
            bottomPerformer && bottomPerformer.pnl >= 0 ? COLORS.yes : COLORS.no
          }
        />
      </div>

      {/* Intraday P&L chart */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-white/70 mb-4">
          Intraday Portfolio Value
        </h2>

        {chartData.length < 2 ? (
          <div className="flex items-center justify-center h-40 text-white/30 text-sm">
            {isReady ? "Collecting data — check back shortly." : "Loading…"}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart
              data={chartData}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="pnlGradientGreen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.yes} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={COLORS.yes} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="pnlGradientRed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.no} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={COLORS.no} stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid {...GRID_STYLE} />

              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={fmtTime}
                tick={AXIS_STYLE}
                tickLine={false}
                axisLine={false}
                minTickGap={60}
              />

              <YAxis
                tickFormatter={(v) => `$${(v as number).toFixed(0)}`}
                tick={AXIS_STYLE}
                tickLine={false}
                axisLine={false}
                width={56}
              />

              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: "rgba(255,255,255,0.1)", strokeWidth: 1 }}
              />

              <Area
                type="monotone"
                dataKey="totalValue"
                stroke={chartColor}
                strokeWidth={2}
                fill={`url(#${isPositive ? "pnlGradientGreen" : "pnlGradientRed"})`}
                dot={false}
                activeDot={{ r: 4, fill: chartColor, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Historical daily summaries */}
      {dailySummaries.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-white/70 mb-3">
            Historical Daily P&L
          </h2>
          <div className="flex flex-col divide-y divide-white/5">
            {dailySummaries.map((day) => (
              <div
                key={day.date}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="text-white/50">{day.date}</span>
                <span
                  className="font-mono font-medium"
                  style={{
                    color:
                      day.pnl > 0
                        ? COLORS.yes
                        : day.pnl < 0
                        ? COLORS.no
                        : "white",
                  }}
                >
                  {fmtPnl(day.pnl)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-position P&L table */}
      {positionRows.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <h2 className="text-sm font-semibold text-white/70">
              Position P&amp;L
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 text-xs uppercase tracking-wide border-b border-white/5">
                  <th className="text-left px-4 py-3 font-medium">Ticker</th>
                  <th className="text-left px-4 py-3 font-medium">Side</th>
                  <th className="text-right px-4 py-3 font-medium">Qty</th>
                  <th className="text-right px-4 py-3 font-medium">Avg Cost</th>
                  <th className="text-right px-4 py-3 font-medium">Curr. Value</th>
                  <th className="text-right px-4 py-3 font-medium">P&amp;L</th>
                  <th className="text-right px-4 py-3 font-medium">P&amp;L %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {positionRows.map((row) => {
                  const pnlColor =
                    row.pnl > 0
                      ? COLORS.yes
                      : row.pnl < 0
                      ? COLORS.no
                      : "white";
                  return (
                    <tr
                      key={`${row.marketKey}-${row.side}`}
                      className="hover:bg-white/5 transition-colors"
                    >
                      <td className="px-4 py-3 font-semibold text-white">
                        {row.ticker}
                      </td>
                      <td className="px-4 py-3 text-white/60">{row.side}</td>
                      <td className="px-4 py-3 text-right font-mono text-white/80">
                        {row.qty.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white/60">
                        {row.avgCost != null
                          ? `$${(row.avgCost / 100).toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white/80">
                        {formatDollar(row.currentVal)}
                      </td>
                      <td
                        className="px-4 py-3 text-right font-mono font-medium"
                        style={{ color: pnlColor }}
                      >
                        {fmtPnl(row.pnl)}
                      </td>
                      <td
                        className="px-4 py-3 text-right font-mono font-medium"
                        style={{ color: pnlColor }}
                      >
                        {row.pnlPct >= 0 ? "+" : ""}
                        {row.pnlPct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
