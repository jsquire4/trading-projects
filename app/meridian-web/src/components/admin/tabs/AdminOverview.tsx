"use client";

import { useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useFeeVaultBalance } from "@/hooks/useFeeVaultBalance";
import { useTreasuryBalance } from "@/hooks/useTreasuryBalance";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { findGlobalConfig } from "@/lib/pda";

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

// ---------------------------------------------------------------------------
// Emergency Controls
// ---------------------------------------------------------------------------

function EmergencyControls({ markets, isPaused }: { markets: ParsedMarket[]; isPaused: boolean }) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState<string | null>(null);

  const [configPda] = findGlobalConfig();

  const handleAction = useCallback(async (action: string, buildTx: () => Promise<any>) => {
    if (!program || !publicKey) return;
    setSubmitting(action);
    try {
      const tx = await buildTx();
      await sendTransaction(tx, { description: action });
      queryClient.invalidateQueries({ queryKey: ["globalConfig"] });
      queryClient.invalidateQueries({ queryKey: ["markets"] });
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, sendTransaction, queryClient]);

  if (!program || !publicKey) return null;

  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 space-y-3">
      <p className="text-xs font-semibold text-red-400">Emergency Controls</p>
      <div className="flex flex-wrap gap-2">
        {isPaused ? (
          <button
            onClick={() => handleAction("Unpause", () =>
              program.methods.unpause()
                .accountsPartial({ admin: publicKey, config: configPda })
                .transaction()
            )}
            disabled={submitting !== null}
            className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-2 text-xs font-semibold text-green-400 hover:bg-green-500/20 disabled:opacity-30 transition-colors"
          >
            {submitting === "Unpause" ? "..." : "Unpause Platform"}
          </button>
        ) : (
          <>
            <button
              onClick={() => handleAction("Pause", () =>
                program.methods.pause()
                  .accountsPartial({ admin: publicKey, config: configPda })
                  .transaction()
              )}
              disabled={submitting !== null}
              className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-xs font-semibold text-yellow-400 hover:bg-yellow-500/20 disabled:opacity-30 transition-colors"
            >
              {submitting === "Pause" ? "..." : "Pause Platform"}
            </button>
            <button
              onClick={() => handleAction("Circuit Breaker", () =>
                program.methods.circuitBreaker()
                  .accountsPartial({ admin: publicKey, config: configPda })
                  .transaction()
              )}
              disabled={submitting !== null}
              className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-30 transition-colors"
            >
              {submitting === "Circuit Breaker" ? "..." : "Circuit Breaker"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin Settle Panel — force settle any expired unsettled market
// ---------------------------------------------------------------------------

function AdminSettlePanel({ markets }: { markets: ParsedMarket[] }) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [settlePrice, setSettlePrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [configPda] = findGlobalConfig();

  const unsettledMarkets = markets.filter((m) => !m.isSettled);

  const handleAdminSettle = useCallback(async (market: ParsedMarket) => {
    if (!program || !publicKey) return;
    const price = parseFloat(settlePrice);
    if (!price || price <= 0) {
      setError("Enter a valid settlement price");
      return;
    }
    setError(null);
    const priceLamports = Math.round(price * 1_000_000);
    const key = market.publicKey.toBase58();
    setSubmitting(key);
    try {
      const tx = await program.methods
        .adminSettle(new BN(priceLamports))
        .accountsPartial({
          admin: publicKey,
          config: configPda,
          market: market.publicKey,
        })
        .transaction();
      await sendTransaction(tx, { description: `Admin Settle ${market.ticker} @ $${price}` });
      queryClient.invalidateQueries({ queryKey: ["markets"] });
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, settlePrice, configPda, sendTransaction, queryClient]);

  if (!program || !publicKey || unsettledMarkets.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
      <p className="text-xs font-semibold text-amber-400">Admin Settle (Force)</p>
      <p className="text-[10px] text-amber-300/60">
        Force-settle any market with a manual price. Use for testing or when oracle is unavailable.
        Requires admin_settle_delay (5 min) to have passed since market close.
      </p>

      <div className="flex items-center gap-2">
        <span className="text-xs text-white/40">Price $</span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={settlePrice}
          onChange={(e) => { setSettlePrice(e.target.value); setError(null); }}
          placeholder="e.g. 255.50"
          className="w-32 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white font-mono placeholder-white/30 focus:border-accent focus:outline-none"
        />
      </div>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <div className="space-y-1 max-h-48 overflow-y-auto">
        {unsettledMarkets.map((m) => {
          const strike = (Number(m.strikePrice) / 1_000_000).toFixed(0);
          const closeTime = new Date(Number(m.marketCloseUnix) * 1000).toLocaleString();
          const key = m.publicKey.toBase58();
          return (
            <div key={key} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/[0.03]">
              <div className="text-xs">
                <span className="text-white font-medium">{m.ticker}</span>
                <span className="text-white/40 ml-2">${strike}</span>
                <span className="text-white/20 ml-2 text-[10px]">closes {closeTime}</span>
              </div>
              <button
                onClick={() => handleAdminSettle(m)}
                disabled={submitting !== null || !settlePrice}
                className="text-[11px] text-amber-400 hover:text-amber-300 disabled:text-white/20 transition-colors px-2 py-1 rounded border border-amber-500/20 hover:bg-amber-500/10"
              >
                {submitting === key ? "Settling..." : "Force Settle"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

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

      {/* Emergency Controls */}
      <EmergencyControls markets={markets} isPaused={config?.isPaused ?? false} />

      {/* Admin Settle */}
      <AdminSettlePanel markets={markets} />

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
