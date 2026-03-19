"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  useMeridianIndex,
  useIndexHistory,
  useConvictionLeaders,
  useSmartMoney,
} from "@/hooks/useSignals";
import { COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from "@/lib/chartConfig";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateWallet(w: string): string {
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

function indexColor(v: number): string {
  if (v > 60) return "text-green-400";
  if (v < 40) return "text-red-400";
  return "text-amber-400";
}

function indexBg(v: number): string {
  if (v > 60) return "from-green-500/10 to-transparent";
  if (v < 40) return "from-red-500/10 to-transparent";
  return "from-amber-500/10 to-transparent";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SignalsPage() {
  const { data: indexData } = useMeridianIndex();
  const { data: historyData } = useIndexHistory("intraday");
  const { data: leadersData } = useConvictionLeaders(20);
  const { data: smartMoneyData } = useSmartMoney();

  const index = indexData?.value ?? 50;
  const disp = indexData?.dispersion ?? 0;
  const tickers = indexData?.tickers ?? [];
  const snapshots = historyData?.snapshots ?? [];
  const leaders = leadersData?.leaders ?? [];
  const signals = smartMoneyData?.signals ?? [];

  const chartData = useMemo(
    () =>
      snapshots.map((s) => ({
        time: new Date(s.timestamp * 1000).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        value: parseFloat(s.value.toFixed(1)),
      })),
    [snapshots],
  );

  const barData = useMemo(
    () => tickers.map((t) => ({ ticker: t.ticker, vwap: parseFloat(t.vwap.toFixed(1)) })),
    [tickers],
  );

  const lineColor = index > 60 ? COLORS.yes : index < 40 ? COLORS.no : "#f59e0b";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gradient">Signals</h1>
        <p className="text-white/40 text-sm mt-1">
          Market intelligence derived from binary outcome trading activity.
        </p>
      </div>

      {/* ── Index Gauge + Intraday Chart ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Gauge */}
        <div
          className={`lg:col-span-2 bg-gradient-to-b ${indexBg(index)} bg-white/5 rounded-xl p-6 border border-white/10 flex flex-col gap-4`}
        >
          <div className="text-xs font-semibold text-white/40 uppercase tracking-wider">
            Meridian Index
          </div>
          <div className={`text-6xl font-bold font-mono tabular-nums ${indexColor(index)}`}>
            {index.toFixed(0)}
          </div>
          <div className="text-xs text-white/40">
            Dispersion:{" "}
            <span className="text-white/70 font-mono">{disp.toFixed(1)}</span>
            <span className="ml-2 text-white/30">
              {disp < 5
                ? "— tickers moving together"
                : disp < 15
                  ? "— moderate spread"
                  : "— tickers diverging"}
            </span>
          </div>
          <div className="text-[10px] text-white/20 leading-relaxed">
            Volume-weighted average of MAG7 implied probabilities from fill VWAP.
            0 = unanimous No, 100 = unanimous Yes.
          </div>
        </div>

        {/* Intraday chart */}
        <div className="lg:col-span-3 bg-white/5 rounded-xl p-6 border border-white/10">
          <h2 className="text-sm font-semibold mb-4 text-white/70">Intraday History</h2>
          {chartData.length < 2 ? (
            <div className="flex h-48 items-center justify-center text-white/30 text-sm">
              Snapshots accumulate every 5 minutes during trading hours
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="indexGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="time" tick={AXIS_STYLE} tickLine={false} axisLine={false} minTickGap={40} />
                <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} domain={[0, 100]} width={32} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={lineColor}
                  strokeWidth={2}
                  fill="url(#indexGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Per-Ticker Breakdown ──────────────────────────── */}
      <div className="bg-white/5 rounded-xl p-6 border border-white/10">
        <h2 className="text-sm font-semibold mb-4 text-white/70">Per-Ticker VWAP</h2>
        {barData.length === 0 ? (
          <div className="text-white/30 text-sm">No fill data</div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={barData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRID_STYLE} vertical={false} />
              <XAxis dataKey="ticker" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} domain={[0, 100]} width={32} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="vwap" fill={COLORS.accent} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
        <div className="mt-4 grid grid-cols-4 sm:grid-cols-7 gap-2">
          {tickers.map((t) => (
            <div key={t.ticker} className="bg-white/5 rounded-lg p-2 text-center">
              <div className="text-[10px] text-white/40 mb-0.5">{t.ticker}</div>
              <div className={`text-sm font-mono font-bold ${indexColor(t.vwap)}`}>
                {t.vwap.toFixed(0)}
              </div>
              <div className="text-[9px] text-white/20">{t.fillCount} fills</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Smart Money Flow ─────────────────────────────── */}
      <div className="bg-white/5 rounded-xl p-6 border border-white/10">
        <h2 className="text-sm font-semibold mb-1 text-white/70">Smart Money Flow</h2>
        <p className="text-[10px] text-white/25 mb-4">
          Anonymous early-conviction order flow for today&apos;s active markets,
          weighted by time-to-close and price distance from 50.
        </p>
        {signals.length === 0 ? (
          <div className="text-white/30 text-sm">No signals yet today</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/30 text-[10px] border-b border-white/10">
                  <th className="pb-2 pr-4">Ticker</th>
                  <th className="pb-2 pr-4">Direction</th>
                  <th className="pb-2 pr-4">Strength</th>
                  <th className="pb-2 pr-4">Fills</th>
                  <th className="pb-2">Avg Conviction</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={i} className="border-b border-white/5 last:border-0">
                    <td className="py-2 pr-4 font-mono text-white/80">{s.ticker}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          s.direction === "yes"
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {s.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-white/60">{s.strength.toFixed(3)}</td>
                    <td className="py-2 pr-4 text-white/60">{s.fillCount}</td>
                    <td className="py-2 font-mono text-white/60">{s.avgConviction.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Conviction Leaderboard ───────────────────────── */}
      <div className="bg-white/5 rounded-xl p-6 border border-white/10">
        <h2 className="text-sm font-semibold mb-1 text-white/70">Conviction Leaderboard</h2>
        <p className="text-[10px] text-white/25 mb-4">
          Top wallets by settled-trade conviction score. Rewards early trades
          at decisive prices on correct outcomes. Min 3 settled trades.
        </p>
        {leaders.length === 0 ? (
          <div className="text-white/30 text-sm">No settled trades scored yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/30 text-[10px] border-b border-white/10">
                  <th className="pb-2 pr-4">#</th>
                  <th className="pb-2 pr-4">Wallet</th>
                  <th className="pb-2 pr-4">Score</th>
                  <th className="pb-2 pr-4">Trades</th>
                  <th className="pb-2 pr-4">Win Rate</th>
                  <th className="pb-2">Best Ticker</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((l, i) => (
                  <tr key={l.wallet} className="border-b border-white/5 last:border-0">
                    <td className="py-2 pr-4 text-white/30 font-mono">{i + 1}</td>
                    <td className="py-2 pr-4 font-mono text-white/70">{truncateWallet(l.wallet)}</td>
                    <td className="py-2 pr-4 font-mono font-bold text-white/90">
                      {l.score.toFixed(3)}
                    </td>
                    <td className="py-2 pr-4 text-white/60">{l.trades}</td>
                    <td
                      className={`py-2 pr-4 font-mono ${
                        l.winRate >= 0.5 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {(l.winRate * 100).toFixed(0)}%
                    </td>
                    <td className="py-2 font-mono text-white/50">{l.topTicker}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
