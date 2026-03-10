"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMarkets } from "@/hooks/useMarkets";
import { WalletButton } from "@/components/WalletButton";

// ---------------------------------------------------------------------------
// How It Works step card
// ---------------------------------------------------------------------------

interface StepProps {
  number: string;
  title: string;
  description: string;
}

function Step({ number, title, description }: StepProps) {
  return (
    <div className="bg-white/5 rounded-xl p-6 border border-white/10 flex flex-col gap-3">
      <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center text-accent font-bold text-sm">
        {number}
      </div>
      <h3 className="text-white font-bold text-lg">{title}</h3>
      <p className="text-white/50 text-sm leading-relaxed">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live market summary row
// ---------------------------------------------------------------------------

interface TickerSummaryRowProps {
  ticker: string;
  strikeCount: number;
  minStrike: number;
  maxStrike: number;
}

function TickerSummaryRow({
  ticker,
  strikeCount,
  minStrike,
  maxStrike,
}: TickerSummaryRowProps) {
  const minStr = (minStrike / 1_000_000).toFixed(2);
  const maxStr = (maxStrike / 1_000_000).toFixed(2);
  const range =
    strikeCount === 1 ? `$${minStr}` : `$${minStr} – $${maxStr}`;

  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/5 border border-white/10">
      <span className="text-white font-bold text-sm w-16">{ticker}</span>
      <span className="text-white/50 text-sm">
        {strikeCount} active strike{strikeCount !== 1 ? "s" : ""}
      </span>
      <span className="text-white/70 text-sm font-mono">{range}</span>
      <Link
        href={`/trade/${ticker}`}
        className="text-xs text-accent hover:text-accent/80 transition-colors font-medium"
      >
        View markets
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
}

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="bg-white/5 rounded-xl p-5 border border-white/10 text-center">
      <div className="text-2xl font-bold text-white mb-1">{value}</div>
      <div className="text-xs text-white/50 uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-white/30 mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { data: markets = [], isLoading } = useMarkets();

  // Derive per-ticker summaries from active (unsettled) markets
  const tickerSummaries = useMemo(() => {
    const active = markets.filter((m) => !m.isSettled && !m.isClosed);

    const grouped = new Map<
      string,
      { count: number; min: number; max: number }
    >();

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
      .map(([ticker, { count, min, max }]) => ({
        ticker,
        strikeCount: count,
        minStrike: min,
        maxStrike: max,
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [markets]);

  const activeCount = markets.filter((m) => !m.isSettled && !m.isClosed).length;
  const settledCount = markets.filter((m) => m.isSettled).length;
  const totalMinted = markets.reduce(
    (sum, m) => sum + Number(m.totalMinted),
    0,
  );
  const totalVolume = totalMinted > 0
    ? (totalMinted / 1_000_000).toFixed(0)
    : null;

  return (
    <div className="flex flex-col gap-16 py-4">

      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col items-center text-center gap-6 pt-8">
        <div className="inline-block rounded-full bg-accent/10 border border-accent/20 px-4 py-1 text-xs text-accent font-medium tracking-wider uppercase">
          0DTE — Settles 4 PM ET daily
        </div>
        <h1 className="text-5xl font-bold text-white leading-tight max-w-2xl">
          Binary Stock Outcomes on Solana
        </h1>
        <p className="text-white/50 text-lg max-w-xl">
          Trade Yes/No contracts on MAG7 stocks. Pay $1 USDC, win $1 USDC.
          Every contract settles at the close.
        </p>
        <div className="flex items-center gap-4 mt-2">
          <Link
            href="/trade"
            className="bg-accent hover:bg-accent/80 text-white font-semibold rounded-lg px-6 py-2.5 transition-colors text-sm"
          >
            View Markets
          </Link>
          <WalletButton />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* How It Works                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="text-xl font-bold text-white mb-6">How It Works</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Step
            number="1"
            title="Fund Your Wallet"
            description="Connect a Solana wallet and deposit USDC. Each contract costs exactly $1 to enter a position."
          />
          <Step
            number="2"
            title="Trade Yes or No"
            description="Pick a MAG7 ticker and strike price. Buy Yes if you think the stock closes above the strike, or No if you think it closes below."
          />
          <Step
            number="3"
            title="Collect at Settlement"
            description="At 4 PM ET, the oracle reports the closing price. Winning side collects $1 USDC per token. Losers receive nothing."
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Live Market Summary                                                 */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Live Markets</h2>
          <Link
            href="/trade"
            className="text-sm text-accent hover:text-accent/80 transition-colors"
          >
            See all markets
          </Link>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 rounded-lg bg-white/5 border border-white/10 animate-pulse"
              />
            ))}
          </div>
        ) : tickerSummaries.length === 0 ? (
          <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-10 text-center text-white/40 text-sm">
            No active markets right now. Check back before market open.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {tickerSummaries.map((s) => (
              <TickerSummaryRow
                key={s.ticker}
                ticker={s.ticker}
                strikeCount={s.strikeCount}
                minStrike={s.minStrike}
                maxStrike={s.maxStrike}
              />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Key Stats                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="text-xl font-bold text-white mb-4">Platform Stats</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Active Markets"
            value={isLoading ? "--" : String(activeCount)}
            sub="open for trading"
          />
          <StatCard
            label="Tickers"
            value={isLoading ? "--" : String(tickerSummaries.length)}
            sub="MAG7 coverage"
          />
          <StatCard
            label="Settled Markets"
            value={isLoading ? "--" : String(settledCount)}
          />
          <StatCard
            label="Total Volume"
            value={
              isLoading
                ? "--"
                : totalVolume !== null
                ? `$${Number(totalVolume).toLocaleString()}`
                : "--"
            }
            sub="USDC minted"
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* CTA                                                                 */}
      {/* ------------------------------------------------------------------ */}
      <section className="rounded-2xl bg-white/5 border border-white/10 px-8 py-10 flex flex-col items-center text-center gap-5">
        <h2 className="text-2xl font-bold text-white">Ready to trade?</h2>
        <p className="text-white/50 text-sm max-w-md">
          Connect your Solana wallet to place orders, manage positions, and
          redeem winnings — all on-chain, no counterparty risk.
        </p>
        <div className="flex items-center gap-4">
          <Link
            href="/trade"
            className="bg-white/10 hover:bg-white/20 text-white rounded-lg px-4 py-2 text-sm transition-colors"
          >
            Browse Markets
          </Link>
          <WalletButton />
        </div>
      </section>

    </div>
  );
}
