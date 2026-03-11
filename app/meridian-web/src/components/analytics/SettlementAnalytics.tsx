"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useSettlementEvents, type IndexedEvent } from "@/hooks/useAnalyticsData";
import {
  COLORS,
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  formatPercent,
} from "@/lib/chartConfig";

// ---------------------------------------------------------------------------
// Parsed settlement data shape
// ---------------------------------------------------------------------------

interface SettlementData {
  market: string;
  ticker: string;
  strikePrice: number;
  settlementPrice: number;
  outcome: number; // 1 = Yes wins, 2 = No wins
  timestamp: number;
}

function parseSettlement(event: IndexedEvent): SettlementData | null {
  try {
    const d = JSON.parse(event.data);
    const strikePrice = Number(d.strikePrice);
    const settlementPrice = Number(d.settlementPrice);
    const outcome = Number(d.outcome);
    const timestamp = Number(d.timestamp ?? event.timestamp);

    // NaN guard (#21)
    if (isNaN(strikePrice) || isNaN(settlementPrice) || isNaN(outcome) || isNaN(timestamp)) {
      return null;
    }

    return {
      market: d.market ?? event.market,
      ticker: d.ticker ?? "UNKNOWN",
      strikePrice,
      settlementPrice,
      outcome,
      timestamp,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bucket helpers for calibration chart
// ---------------------------------------------------------------------------

const BUCKET_LABELS = [
  "0-10%",
  "10-20%",
  "20-30%",
  "30-40%",
  "40-50%",
  "50-60%",
  "60-70%",
  "70-80%",
  "80-90%",
  "90-100%",
];

/** Map a 0–1 ratio to a bucket index 0–9. */
function toBucket(ratio: number): number {
  const idx = Math.floor(ratio * 10);
  return Math.min(idx, 9);
}

interface CalibrationBucket {
  label: string;
  midpoint: number; // 0.05, 0.15, … 0.95
  total: number;
  yesWins: number;
  realizedRate: number;
}

function buildCalibration(settlements: SettlementData[]): CalibrationBucket[] {
  const buckets: { total: number; yesWins: number }[] = Array.from(
    { length: 10 },
    () => ({ total: 0, yesWins: 0 }),
  );

  for (const s of settlements) {
    if (s.strikePrice <= 0) continue;
    // NOTE: True implied probability requires pre-settlement Yes token prices,
    // which are not yet collected. As a proxy, we bucket by the distance of
    // settlement price from strike, mapped to [0, 1]. This measures "how
    // decisive the outcome was", NOT the market's ex-ante belief. The chart
    // axis is labeled "Distance from Strike (%)" to avoid misleading users.
    const aboveStrike = s.settlementPrice >= s.strikePrice;
    const distFrac = Math.min(1, Math.abs(s.settlementPrice - s.strikePrice) / s.strikePrice);
    const ratio = aboveStrike ? 0.5 + 0.5 * distFrac : 0.5 - 0.5 * distFrac;
    const idx = toBucket(ratio);
    buckets[idx].total += 1;
    if (s.outcome === 1) buckets[idx].yesWins += 1;
  }

  return buckets.map((b, i) => ({
    label: BUCKET_LABELS[i],
    midpoint: i * 0.1 + 0.05,
    total: b.total,
    yesWins: b.yesWins,
    realizedRate: b.total > 0 ? b.yesWins / b.total : 0,
  }));
}

// ---------------------------------------------------------------------------
// Accuracy stats
// ---------------------------------------------------------------------------

interface AccuracyStats {
  totalSettled: number;
  correctPredictions: number;
  accuracy: number;
}

function computeAccuracy(settlements: SettlementData[]): AccuracyStats {
  let correct = 0;
  for (const s of settlements) {
    if (s.strikePrice <= 0) continue;
    // Yes wins when settlementPrice >= strikePrice
    const impliedYesFavorite = s.settlementPrice >= s.strikePrice;
    const yesWon = s.outcome === 1;
    if (impliedYesFavorite === yesWon) correct += 1;
  }
  return {
    totalSettled: settlements.length,
    correctPredictions: correct,
    accuracy: settlements.length > 0 ? correct / settlements.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard by ticker
// ---------------------------------------------------------------------------

interface TickerRow {
  ticker: string;
  totalSettled: number;
  yesWins: number;
  noWins: number;
}

function buildLeaderboard(settlements: SettlementData[]): TickerRow[] {
  const map = new Map<string, TickerRow>();
  for (const s of settlements) {
    let row = map.get(s.ticker);
    if (!row) {
      row = { ticker: s.ticker, totalSettled: 0, yesWins: 0, noWins: 0 };
      map.set(s.ticker, row);
    }
    row.totalSettled += 1;
    if (s.outcome === 1) row.yesWins += 1;
    else if (s.outcome === 2) row.noWins += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.totalSettled - a.totalSettled);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-5 py-4">
      <p className="text-xs text-white/50 mb-1">{label}</p>
      <p className="text-3xl font-bold font-mono text-white">{value}</p>
      {sub && <p className="text-xs text-white/40 mt-1">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettlementAnalytics() {
  const { data: events, isLoading, isError, error } = useSettlementEvents();

  const settlements = useMemo(() => {
    if (!events) return [];
    return events.map(parseSettlement).filter((s): s is SettlementData => s !== null);
  }, [events]);

  const calibration = useMemo(() => buildCalibration(settlements), [settlements]);
  const accuracy = useMemo(() => computeAccuracy(settlements), [settlements]);
  const leaderboard = useMemo(() => buildLeaderboard(settlements), [settlements]);

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-white">Settlement Analytics</h2>
        <div className="flex items-center gap-3 text-white/50 py-12">
          <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
          <span className="text-sm">Loading settlement data...</span>
        </div>
      </div>
    );
  }

  // Error state — treat connection failures (event indexer offline) as empty
  if (isError) {
    const isConnectionError =
      error instanceof Error &&
      (error.message.includes("Failed to fetch") || error.message.includes("ECONNREFUSED"));
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-white">Settlement Analytics</h2>
        <div className="rounded-lg border border-white/10 bg-white/5 px-6 py-12 text-center">
          <p className="text-white/50 text-sm">
            {isConnectionError
              ? "Event indexer is not running."
              : "Failed to load settlement data."}
          </p>
          <p className="text-white/30 text-xs mt-1">
            {isConnectionError
              ? "Start the event-indexer service to see settlement analytics."
              : error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (settlements.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-white">Settlement Analytics</h2>
        <div className="rounded-lg border border-white/10 bg-white/5 px-6 py-12 text-center">
          <p className="text-white/50 text-sm">No settlement data yet.</p>
          <p className="text-white/30 text-xs mt-1">
            Analytics will populate once markets begin settling.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h2 className="text-lg font-semibold text-white">Settlement Analytics</h2>

      {/* ----------------------------------------------------------------- */}
      {/* Section A: Calibration Chart                                      */}
      {/* ----------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-white/70 mb-3">Calibration Chart</h3>
        <p className="text-xs text-white/40 mb-4">
          Buckets by distance from strike (settlement/strike ratio). Diagonal line = perfect calibration.
          <br />
          <em>Note: Uses settlement-to-strike distance as a proxy, not true implied probability.
          True calibration requires pre-settlement Yes token fill prices, which are not yet collected.</em>
        </p>
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={calibration} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis
                dataKey="label"
                tick={AXIS_STYLE}
                axisLine={{ stroke: COLORS.grid }}
                tickLine={false}
              />
              <YAxis
                tick={AXIS_STYLE}
                axisLine={{ stroke: COLORS.grid }}
                tickLine={false}
                tickFormatter={(v: number) => formatPercent(v)}
                domain={[0, 1]}
              />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(value: any, name: any) => {
                  if (name === "realizedRate") return [formatPercent(Number(value)), "Realized Win Rate"];
                  return [value, String(name)];
                }}
                labelFormatter={(label: any) => `Bucket: ${label}`}
              />
              {/* Perfect calibration diagonal via reference points */}
              {calibration.map((b) => (
                <ReferenceLine
                  key={b.label}
                  segment={[
                    { x: b.label, y: Math.max(0, b.midpoint - 0.05) },
                    { x: b.label, y: Math.min(1, b.midpoint + 0.05) },
                  ]}
                  stroke={COLORS.neutral}
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  ifOverflow="extendDomain"
                />
              ))}
              <ReferenceLine
                y={0}
                stroke={COLORS.grid}
              />
              <Bar dataKey="realizedRate" radius={[4, 4, 0, 0]} maxBarSize={40}>
                {calibration.map((entry) => (
                  <Cell
                    key={entry.label}
                    fill={
                      Math.abs(entry.realizedRate - entry.midpoint) < 0.15
                        ? COLORS.yes
                        : COLORS.accent
                    }
                    fillOpacity={entry.total > 0 ? 0.85 : 0.2}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-2 text-xs text-white/40">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLORS.yes }} />
              Within 15% of perfect calibration
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLORS.accent }} />
              Outside 15% band
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-4"
                style={{ backgroundColor: COLORS.neutral, opacity: 0.6 }}
              />
              Perfect calibration
            </span>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Section B: Accuracy Summary                                       */}
      {/* ----------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-white/70 mb-3">Accuracy Summary</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label="Total Markets Settled"
            value={String(accuracy.totalSettled)}
          />
          <StatCard
            label="Correct Predictions"
            value={String(accuracy.correctPredictions)}
            sub={`Outcome matched implied favorite`}
          />
          <StatCard
            label="Overall Accuracy"
            value={formatPercent(accuracy.accuracy)}
            sub="Favorite = settlement price on same side as strike"
          />
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Section C: Leaderboard by Ticker                                  */}
      {/* ----------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-white/70 mb-3">Leaderboard by Ticker</h3>
        {leaderboard.length === 0 ? (
          <p className="text-xs text-white/40">No ticker data available.</p>
        ) : (
          <div className="rounded-lg border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/5">
                  <th className="text-left px-4 py-2 text-xs font-medium text-white/50">Ticker</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-white/50">Settled</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-white/50">Yes Wins</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-white/50">No Wins</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-white/50">Yes Rate</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row) => (
                  <tr
                    key={row.ticker}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <td className="px-4 py-2 font-mono font-medium text-white">
                      {row.ticker}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-white/70">
                      {row.totalSettled}
                    </td>
                    <td className="px-4 py-2 text-right font-mono" style={{ color: COLORS.yes }}>
                      {row.yesWins}
                    </td>
                    <td className="px-4 py-2 text-right font-mono" style={{ color: COLORS.no }}>
                      {row.noWins}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-white/70">
                      {row.totalSettled > 0
                        ? formatPercent(row.yesWins / row.totalSettled)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
