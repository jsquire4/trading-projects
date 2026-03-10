"use client";

interface AggregateStatsProps {
  marketsCount: number;
  totalMarkets: number;
  usdcBalance: number | null;
}

export function AggregateStats({ marketsCount, totalMarkets, usdcBalance }: AggregateStatsProps) {
  const settledCount = totalMarkets - marketsCount;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <StatCard label="Active Markets" value={String(marketsCount)} />
      <StatCard label="Settled" value={String(settledCount)} />
      <StatCard
        label="USDC Balance"
        value={usdcBalance !== null ? `$${usdcBalance.toFixed(2)}` : "--"}
      />
      <StatCard label="Total Markets" value={String(totalMarkets)} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-center">
      <div className="text-xl font-bold text-white mb-0.5">{value}</div>
      <div className="text-[11px] text-white/40 uppercase tracking-wider">{label}</div>
    </div>
  );
}
