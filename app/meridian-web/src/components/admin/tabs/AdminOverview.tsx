"use client";

import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useFeeVaultBalance } from "@/hooks/useFeeVaultBalance";
import { useTreasuryBalance } from "@/hooks/useTreasuryBalance";
import { useMarkets } from "@/hooks/useMarkets";

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: "green" | "blue" | "purple" | "amber";
}) {
  return (
    <div className={`rounded-lg border border-white/10 bg-white/5 p-4 card-accent-${accent}`}>
      <p className="text-xs text-white/40 mb-1">{label}</p>
      <p className="text-lg font-semibold text-white tabular-nums font-mono">{value}</p>
      {sub && <p className="text-[10px] text-white/30 mt-1">{sub}</p>}
    </div>
  );
}

export function AdminOverview() {
  const { data: config } = useGlobalConfig();
  const { data: feeVault } = useFeeVaultBalance();
  const { data: treasury } = useTreasuryBalance();
  const { data: markets = [] } = useMarkets();

  const activeCount = markets.filter((m) => !m.isSettled).length;
  const pausedCount = 0; // per-market pause removed; global pause only
  const settledCount = markets.filter((m) => m.isSettled).length;
  const closedCount = 0; // markets are destroyed on close, not flagged

  const obligations = config ? Number(config.obligations) / 1e6 : 0;
  const reserve = config ? Number(config.operatingReserve) / 1e6 : 0;
  const treasuryBal = treasury?.balance ?? 0;
  const available = Math.max(0, treasuryBal - obligations - reserve);

  return (
    <div className="space-y-4">
      {/* Balance row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Fee Vault"
          value={feeVault ? `$${feeVault.balance.toFixed(2)}` : "—"}
          sub="Collected protocol fees"
          accent="green"
        />
        <StatCard
          label="Treasury"
          value={treasury ? `$${treasury.balance.toFixed(2)}` : "—"}
          sub={`Obligations: $${obligations.toFixed(2)} · Reserve: $${reserve.toFixed(2)}`}
          accent="blue"
        />
        <StatCard
          label="Available Surplus"
          value={`$${available.toFixed(2)}`}
          sub="Treasury − obligations − reserve"
          accent="purple"
        />
        <StatCard
          label="Markets"
          value={`${markets.length}`}
          sub={`${activeCount} active · ${pausedCount} paused · ${settledCount} settled · ${closedCount} closed`}
          accent="amber"
        />
      </div>

      {/* Status row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <p className="text-xs text-white/40 mb-2">Platform Status</p>
          <div className="flex items-center gap-2">
            {config?.isPaused ? (
              <span className="text-xs text-yellow-400 bg-yellow-500/20 px-2 py-0.5 rounded">PAUSED</span>
            ) : (
              <span className="text-xs text-green-400 bg-green-500/20 px-2 py-0.5 rounded">ACTIVE</span>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <p className="text-xs text-white/40 mb-2">Oracle Type</p>
          <p className="text-sm text-white font-medium">
            {config?.oracleType === 1 ? "Pyth" : "Mock"}
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <p className="text-xs text-white/40 mb-2">Admin</p>
          <p className="text-xs text-white/60 font-mono truncate">
            {config?.admin.toBase58() ?? "—"}
          </p>
          {config?.pendingAdmin && (
            <p className="text-[10px] text-amber-400 mt-1">
              Pending transfer → {config.pendingAdmin.toBase58().slice(0, 8)}...
            </p>
          )}
        </div>
      </div>

      {/* Config summary */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="text-xs text-white/40 mb-3">Configuration</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
          <div>
            <p className="text-white/40 text-xs">Fee</p>
            <p className="text-white font-mono">{config?.feeBps ?? "—"} bps</p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Strike Fee</p>
            <p className="text-white font-mono">
              {config ? `$${(Number(config.strikeCreationFee) / 1e6).toFixed(2)}` : "—"}
            </p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Staleness</p>
            <p className="text-white font-mono">{config ? `${config.stalenessThreshold}s` : "—"}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Confidence</p>
            <p className="text-white font-mono">{config ? `${config.confidenceBps} bps` : "—"}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Blackout</p>
            <p className="text-white font-mono">
              {config ? `${config.settlementBlackoutMinutes} min` : "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
