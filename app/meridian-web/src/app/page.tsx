"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/useMarkets";
import { useNetwork } from "@/hooks/useNetwork";
import { useQuotes } from "@/hooks/useAnalyticsData";
import { WalletButton } from "@/components/WalletButton";
import { FaucetButton } from "@/components/FaucetButton";

// ---------------------------------------------------------------------------
// Floating particles — random sparkle dots behind the hero
// ---------------------------------------------------------------------------

function Particles() {
  // Static positions/delays — no Math.random() in render
  const dots = [
    { left: "12%", delay: "0s", dur: "4s", color: "bg-green-400" },
    { left: "28%", delay: "1.2s", dur: "5s", color: "bg-blue-400" },
    { left: "45%", delay: "0.5s", dur: "3.5s", color: "bg-purple-400" },
    { left: "62%", delay: "2s", dur: "4.5s", color: "bg-green-400" },
    { left: "78%", delay: "0.8s", dur: "5.5s", color: "bg-blue-400" },
    { left: "88%", delay: "1.5s", dur: "3s", color: "bg-amber-400" },
    { left: "35%", delay: "2.5s", dur: "4s", color: "bg-purple-400" },
    { left: "55%", delay: "3s", dur: "3.5s", color: "bg-green-400" },
    { left: "8%", delay: "1.8s", dur: "5s", color: "bg-cyan-400" },
    { left: "92%", delay: "0.3s", dur: "4.5s", color: "bg-pink-400" },
  ];

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {dots.map((d, i) => (
        <div
          key={i}
          className={`absolute bottom-0 w-1 h-1 rounded-full ${d.color} opacity-0`}
          style={{
            left: d.left,
            animation: `float-up ${d.dur} ease-out ${d.delay} infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// How It Works step card
// ---------------------------------------------------------------------------

const STEP_ACCENTS = [
  { border: "border-green-500/30", glow: "shadow-[0_0_20px_rgba(34,197,94,0.12)]", icon: "from-green-500/30 to-emerald-500/10", num: "text-green-400", pulse: "shadow-[0_0_15px_rgba(34,197,94,0.2)]" },
  { border: "border-blue-500/30", glow: "shadow-[0_0_20px_rgba(59,130,246,0.12)]", icon: "from-blue-500/30 to-cyan-500/10", num: "text-blue-400", pulse: "shadow-[0_0_15px_rgba(59,130,246,0.2)]" },
  { border: "border-purple-500/30", glow: "shadow-[0_0_20px_rgba(168,85,247,0.12)]", icon: "from-purple-500/30 to-violet-500/10", num: "text-purple-400", pulse: "shadow-[0_0_15px_rgba(168,85,247,0.2)]" },
];

function Step({ number, title, description, accent, delay }: {
  number: string; title: string; description: string;
  accent: typeof STEP_ACCENTS[number]; delay: string;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-xl p-6 border ${accent.border} ${accent.glow} transition-all duration-300 hover:scale-[1.03] hover:${accent.pulse} fade-up`}
      style={{ animationDelay: delay }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent" />
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
      <div className="relative flex flex-col gap-3">
        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${accent.icon} border border-white/10 flex items-center justify-center ${accent.num} font-bold text-lg`}>
          {number}
        </div>
        <h3 className="text-white font-bold text-lg">{title}</h3>
        <p className="text-white/50 text-sm leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card — breathing glow + animated value
// ---------------------------------------------------------------------------

const STAT_STYLES = [
  { gradient: "from-green-500/20 via-emerald-500/10 to-transparent", border: "border-green-500/25", glowColor: "rgba(34,197,94,0.15)", accent: "text-green-400", label: "text-green-400/60", ring: "ring-green-500/20" },
  { gradient: "from-blue-500/20 via-cyan-500/10 to-transparent", border: "border-blue-500/25", glowColor: "rgba(59,130,246,0.15)", accent: "text-blue-400", label: "text-blue-400/60", ring: "ring-blue-500/20" },
  { gradient: "from-purple-500/20 via-violet-500/10 to-transparent", border: "border-purple-500/25", glowColor: "rgba(168,85,247,0.15)", accent: "text-purple-400", label: "text-purple-400/60", ring: "ring-purple-500/20" },
  { gradient: "from-amber-500/20 via-orange-500/10 to-transparent", border: "border-amber-500/25", glowColor: "rgba(245,158,11,0.15)", accent: "text-amber-400", label: "text-amber-400/60", ring: "ring-amber-500/20" },
];

function StatCard({ label, value, sub, style, delay }: {
  label: string; value: string; sub?: string;
  style: typeof STAT_STYLES[number]; delay: string;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-xl border ${style.border} transition-all duration-300 hover:scale-[1.04] fade-up`}
      style={{
        animationDelay: delay,
        boxShadow: `0 0 30px -5px ${style.glowColor}`,
      }}
    >
      {/* Breathing glow overlay */}
      <div
        className="absolute inset-0 rounded-xl glow-breathe pointer-events-none"
        style={{ boxShadow: `inset 0 0 40px -10px ${style.glowColor}` }}
      />
      <div className={`absolute inset-0 bg-gradient-to-br ${style.gradient}`} />
      {/* Shimmer sweep */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
      <div className="relative px-5 py-5">
        <div className={`text-[10px] uppercase tracking-[0.15em] font-semibold ${style.label} mb-2`}>{label}</div>
        <div className={`text-3xl font-bold tabular-nums ${style.accent} group-hover:count-pop`}>{value}</div>
        {sub && <div className="text-[11px] text-white/30 mt-1.5">{sub}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live market ticker row — party mode
// ---------------------------------------------------------------------------

function MarketRow({
  ticker, strikeCount, minStrike, maxStrike, price, changePct, index,
}: {
  ticker: string; strikeCount: number; minStrike: number; maxStrike: number;
  price: number; changePct: number; index: number;
}) {
  const minStr = (minStrike / 1_000_000).toFixed(0);
  const maxStr = (maxStrike / 1_000_000).toFixed(0);
  const range = strikeCount === 1 ? `$${minStr}` : `$${minStr} – $${maxStr}`;
  const isUp = changePct >= 0;

  return (
    <Link
      href={`/trade/${ticker}`}
      className="group relative overflow-hidden grid grid-cols-[80px_1fr_1fr_1fr_100px] items-center gap-4 px-5 py-4 hover:bg-white/[0.03] transition-all duration-200 slide-in"
      style={{ animationDelay: `${index * 0.08}s` }}
    >
      {/* Hover gradient sweep */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-green-500/[0.04] via-transparent to-blue-500/[0.04]" />
      {/* Shimmer */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />

      {/* Ticker — glows on hover */}
      <div className="relative">
        <span className="text-base font-bold text-white group-hover:text-green-400 transition-colors duration-200">{ticker}</span>
      </div>

      {/* Price + animated change badge */}
      <div className="relative flex items-center gap-3">
        {price > 0 ? (
          <>
            <span className="text-sm font-mono font-medium text-white/80 tabular-nums">
              ${price.toFixed(2)}
            </span>
            <span className={`text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full ${
              isUp
                ? "text-green-400 bg-green-500/15 shadow-[0_0_8px_rgba(34,197,94,0.15)]"
                : "text-red-400 bg-red-500/15 shadow-[0_0_8px_rgba(239,68,68,0.15)]"
            }`}>
              {isUp ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          </>
        ) : (
          <span className="text-sm text-white/30">--</span>
        )}
      </div>

      {/* Strikes */}
      <div className="relative flex items-center gap-2">
        <span className="text-sm text-white/50 tabular-nums">{strikeCount} strike{strikeCount !== 1 ? "s" : ""}</span>
        <span className="text-white/15">·</span>
        <span className="text-xs font-mono text-white/35 tabular-nums">{range}</span>
      </div>

      {/* Activity bar — animated fill */}
      <div className="relative flex items-center gap-2">
        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bar-fill bg-gradient-to-r from-green-500/70 via-blue-500/60 to-purple-500/50"
            style={{
              width: `${Math.min(100, strikeCount * 15)}%`,
              animationDelay: `${index * 0.1 + 0.3}s`,
            }}
          />
        </div>
      </div>

      {/* Arrow — bounces on hover */}
      <div className="relative text-right">
        <span className="text-xs text-white/20 group-hover:text-accent group-hover:translate-x-1.5 inline-block transition-all duration-300 ease-out">
          Trade →
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { data: markets = [], isLoading } = useMarkets();
  const { isMainnet, isDevnet } = useNetwork();
  const { connected } = useWallet();

  const tickerSummaries = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled);
    const grouped = new Map<string, { count: number; min: number; max: number }>();
    for (const m of active) {
      const price = Number(m.strikePrice);
      const entry = grouped.get(m.ticker);
      if (!entry) {
        grouped.set(m.ticker, { count: 1, min: price, max: price });
      } else {
        entry.count += 1;
        if (price < entry.min) entry.min = price;
        if (price > entry.max) entry.max = price;
      }
    }
    return Array.from(grouped.entries())
      .map(([ticker, { count, min, max }]) => ({ ticker, strikeCount: count, minStrike: min, maxStrike: max }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [markets]);

  const tickerList = useMemo(() => tickerSummaries.map((s) => s.ticker), [tickerSummaries]);
  const { data: quotes = [] } = useQuotes(tickerList);
  const quoteMap = useMemo(() => new Map(quotes.map((q) => [q.symbol, q])), [quotes]);

  const activeCount = markets.filter((m) => !m.isSettled).length;
  const settledCount = markets.filter((m) => m.isSettled).length;
  const totalMinted = markets.reduce((sum, m) => sum + Number(m.totalMinted), 0);
  const totalVolume = totalMinted > 0 ? `$${(totalMinted / 1_000_000).toLocaleString()}` : "--";

  return (
    <div className="flex flex-col gap-16 py-4">

      {/* ── Hero with floating particles ──────────────────────────────────── */}
      <section className="relative flex flex-col items-center text-center gap-6 pt-8">
        <Particles />

        <div className="relative inline-block rounded-full bg-accent/10 border border-accent/20 px-4 py-1 text-xs text-accent font-medium tracking-wider uppercase fade-up" style={{ animationDelay: "0s" }}>
          {isMainnet ? "Live Trading" : isDevnet ? "Devnet — Test Mode" : "Local — Test Mode"} — 0DTE — Settles 4 PM ET
        </div>

        <h1 className="relative text-5xl font-bold leading-tight max-w-2xl fade-up" style={{ animationDelay: "0.1s" }}>
          <span className="text-gradient text-shimmer bg-clip-text text-transparent" style={{ backgroundSize: "400% auto", backgroundImage: "linear-gradient(to right, #3b82f6, #a855f7, #22c55e, #3b82f6, #a855f7)" }}>
            Binary Stock Outcomes on Solana
          </span>
        </h1>

        <p className="relative text-white/50 text-lg max-w-xl fade-up" style={{ animationDelay: "0.2s" }}>
          Trade Yes/No contracts on MAG7 stocks. Pay $1 USDC, win $1 USDC.
          Every contract settles at the close.
        </p>

        <div className="relative flex items-center gap-4 mt-2 fade-up" style={{ animationDelay: "0.3s" }}>
          <Link
            href="/trade"
            className="group relative overflow-hidden bg-gradient-to-r from-green-500 via-blue-500 to-purple-500 hover:from-green-400 hover:via-blue-400 hover:to-purple-400 text-white font-semibold rounded-lg px-6 py-2.5 transition-all text-sm shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-105"
          >
            <span className="relative z-10">View Markets</span>
            <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-500 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          </Link>
          {connected && !isMainnet ? (
            <FaucetButton className="bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg px-6 py-2.5 transition-all text-sm shadow-lg shadow-blue-500/20 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed" />
          ) : (
            <WalletButton />
          )}
        </div>
      </section>

      {/* ── Platform Stats — breathing, glowing, alive ─────────────────────── */}
      <section>
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-xl font-bold text-white">Platform Stats</h2>
          <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Active Markets" value={isLoading ? "—" : String(activeCount)} sub="open for trading" style={STAT_STYLES[0]} delay="0.1s" />
          <StatCard label="Tickers" value={isLoading ? "—" : String(tickerSummaries.length)} sub="MAG7 coverage" style={STAT_STYLES[1]} delay="0.2s" />
          <StatCard label="Settled" value={isLoading ? "—" : String(settledCount)} sub="contracts resolved" style={STAT_STYLES[2]} delay="0.3s" />
          <StatCard label="Volume" value={isLoading ? "—" : totalVolume} sub="USDC deposited" style={STAT_STYLES[3]} delay="0.4s" />
        </div>
      </section>

      {/* ── How It Works — staggered reveal ────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-xl font-bold text-white">How It Works</h2>
          <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Step number="1" title="Fund Your Wallet" description="Connect a Solana wallet and deposit USDC. Each contract costs exactly $1 to enter a position." accent={STEP_ACCENTS[0]} delay="0.1s" />
          <Step number="2" title="Trade Yes or No" description="Pick a MAG7 ticker and strike price. Buy Yes if you think the stock closes above the strike, or No if you think it closes below." accent={STEP_ACCENTS[1]} delay="0.25s" />
          <Step number="3" title="Collect at Settlement" description="At 4 PM ET, the oracle reports the closing price. Winning side collects $1 USDC per token. Losers receive nothing." accent={STEP_ACCENTS[2]} delay="0.4s" />
        </div>
      </section>

      {/* ── Live Markets — slide-in rows with animated bars ─────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            {/* Triple-ring pulsing indicator */}
            <div className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
              <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-30" style={{ animation: "ring-pulse 2s ease-out 0.5s infinite" }} />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
            </div>
            <h2 className="text-xl font-bold text-white">Live Markets</h2>
            <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
          </div>
          <Link href="/trade" className="text-xs text-accent hover:text-accent/80 transition-colors font-medium">
            See all →
          </Link>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-white/[0.03] border border-white/[0.06] animate-pulse" />
            ))}
          </div>
        ) : tickerSummaries.length === 0 ? (
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-6 py-12 text-center">
            <p className="text-white/40 text-sm">No active markets right now.</p>
            <p className="text-white/25 text-xs mt-1">Check back before market open — markets are created daily at 8:30 AM ET.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
            {/* Table header */}
            <div className="grid grid-cols-[80px_1fr_1fr_1fr_100px] items-center gap-4 px-5 py-2.5 text-[10px] uppercase tracking-[0.12em] text-white/25 font-semibold bg-white/[0.02]">
              <span>Ticker</span>
              <span>Price</span>
              <span>Strikes</span>
              <span>Activity</span>
              <span className="text-right">Action</span>
            </div>

            {tickerSummaries.map((s, i) => {
              const q = quoteMap.get(s.ticker);
              return (
                <MarketRow
                  key={s.ticker}
                  ticker={s.ticker}
                  strikeCount={s.strikeCount}
                  minStrike={s.minStrike}
                  maxStrike={s.maxStrike}
                  price={q?.last ?? 0}
                  changePct={q?.change_percentage ?? 0}
                  index={i}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ── CTA — the grand finale ────────────────────────────────────────── */}
      <section className="group relative overflow-hidden rounded-2xl border border-white/10 px-8 py-10 flex flex-col items-center text-center gap-5">
        {/* Animated gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-green-500/[0.08] via-blue-500/[0.08] to-purple-500/[0.08] group-hover:from-green-500/[0.14] group-hover:via-blue-500/[0.14] group-hover:to-purple-500/[0.14] transition-all duration-700" />
        {/* Breathing glow */}
        <div className="absolute inset-0 glow-breathe" style={{ boxShadow: "inset 0 0 60px -15px rgba(59,130,246,0.12), 0 0 40px -10px rgba(168,85,247,0.08)" }} />
        {/* Shimmer sweep */}
        <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <h2 className="relative text-2xl font-bold">
          <span className="text-gradient text-shimmer bg-clip-text text-transparent" style={{ backgroundSize: "400% auto", backgroundImage: "linear-gradient(to right, #3b82f6, #a855f7, #22c55e, #3b82f6, #a855f7)" }}>
            Ready to trade?
          </span>
        </h2>
        <p className="relative text-white/50 text-sm max-w-md">
          Connect your Solana wallet to place orders, manage positions, and
          redeem winnings — all on-chain, no counterparty risk.
        </p>
        <div className="relative flex items-center gap-4">
          <Link
            href="/trade"
            className="group/btn relative overflow-hidden bg-white/10 hover:bg-white/20 text-white rounded-lg px-5 py-2.5 text-sm font-medium transition-all hover:scale-105 hover:shadow-lg hover:shadow-blue-500/10"
          >
            <span className="relative z-10">Browse Markets</span>
            <div className="absolute inset-0 -translate-x-full group-hover/btn:translate-x-full transition-transform duration-500 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </Link>
          {connected && !isMainnet ? (
            <FaucetButton className="bg-white/10 hover:bg-white/20 text-white rounded-lg px-5 py-2.5 text-sm font-medium transition-all hover:scale-105" />
          ) : (
            <WalletButton />
          )}
        </div>
      </section>
    </div>
  );
}
