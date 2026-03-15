"use client";

import { useState, useCallback } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { findGlobalConfig } from "@/lib/pda";

export function PlatformSettings() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const { data: config } = useGlobalConfig();

  // Transfer admin
  const [newAdminInput, setNewAdminInput] = useState("");
  // Config updates
  const [stalenessInput, setStalenessInput] = useState("");
  const [settlementStalenessInput, setSettlementStalenessInput] = useState("");
  const [confidenceInput, setConfidenceInput] = useState("");
  const [reserveInput, setReserveInput] = useState("");
  const [blackoutInput, setBlackoutInput] = useState("");

  const [submitting, setSubmitting] = useState<string | null>(null);

  const [configAddr] = findGlobalConfig();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["global-config"] });
  }, [queryClient]);

  // Generic action executor — reduces boilerplate across 5 admin handlers
  const handleAction = useCallback(
    async (name: string, buildTx: () => Promise<import("@solana/web3.js").Transaction>, onSuccess?: () => void) => {
      if (!program || !publicKey) return;
      setSubmitting(name);
      try {
        const tx = await buildTx();
        await sendTransaction(tx, { description: name });
        invalidate();
        onSuccess?.();
      } catch { /* handled by toast */ }
      finally { setSubmitting(null); }
    },
    [program, publicKey, sendTransaction, invalidate],
  );

  // ---- Transfer Admin ----
  const handleTransferAdmin = useCallback(async () => {
    if (!newAdminInput) return;
    let newAdmin: PublicKey;
    try { newAdmin = new PublicKey(newAdminInput); }
    catch { return; }
    await handleAction("Transfer Admin", () =>
      program!.methods.transferAdmin(newAdmin)
        .accountsPartial({ admin: publicKey!, config: configAddr })
        .transaction(),
      () => setNewAdminInput(""),
    );
  }, [newAdminInput, handleAction, program, publicKey, configAddr]);

  // ---- Accept Admin ----
  const handleAcceptAdmin = useCallback(async () => {
    await handleAction("Accept Admin Transfer", () =>
      program!.methods.acceptAdmin()
        .accountsPartial({ newAdmin: publicKey!, config: configAddr })
        .transaction(),
    );
  }, [handleAction, program, publicKey, configAddr]);

  // ---- Global Pause/Unpause ----
  const handleGlobalPause = useCallback(async () => {
    if (!config) return;
    const isPaused = config.isPaused;
    await handleAction(isPaused ? "Unpause Platform" : "Pause Platform", () =>
      isPaused
        ? program!.methods.unpause().accountsPartial({ admin: publicKey!, config: configAddr }).transaction()
        : program!.methods.pause().accountsPartial({ admin: publicKey!, config: configAddr }).transaction(),
    );
  }, [config, handleAction, program, publicKey, configAddr]);

  // ---- Update Config ----
  const handleUpdateConfig = useCallback(async () => {
    const stalenessNum = parseInt(stalenessInput, 10);
    const settlementNum = parseInt(settlementStalenessInput, 10);
    const confidenceNum = parseInt(confidenceInput, 10);
    const reserveNum = parseFloat(reserveInput);
    const blackoutNum = parseInt(blackoutInput, 10);

    const staleness = stalenessInput && !isNaN(stalenessNum) && stalenessNum > 0 ? new BN(stalenessNum) : null;
    const settlementStal = settlementStalenessInput && !isNaN(settlementNum) && settlementNum > 0 ? new BN(settlementNum) : null;
    const confidence = confidenceInput && !isNaN(confidenceNum) && confidenceNum > 0 ? new BN(confidenceNum) : null;
    const reserve = reserveInput && !isNaN(reserveNum) && reserveNum >= 0 ? new BN(Math.round(reserveNum * 1_000_000)) : null;
    const blackout = blackoutInput && !isNaN(blackoutNum) && blackoutNum >= 0 ? blackoutNum : null;

    await handleAction("Update Config", () =>
      program!.methods.updateConfig(staleness, settlementStal, confidence, reserve, blackout, null)
        .accountsPartial({ admin: publicKey!, config: configAddr })
        .transaction(),
      () => {
        setStalenessInput("");
        setSettlementStalenessInput("");
        setConfidenceInput("");
        setReserveInput("");
        setBlackoutInput("");
      },
    );
  }, [stalenessInput, settlementStalenessInput, confidenceInput, reserveInput, blackoutInput, handleAction, program, publicKey, configAddr]);

  const isPendingAdmin = config?.pendingAdmin && publicKey?.equals(config.pendingAdmin);

  return (
    <div className="space-y-4">
      {/* Admin Transfer */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white/80">Admin Authority</h3>

        <div className="text-sm">
          <p className="text-white/40 text-xs">Current Admin</p>
          <p className="text-white/60 font-mono text-xs truncate">{config?.admin.toBase58() ?? "—"}</p>
        </div>

        {config?.pendingAdmin && (
          <div className="text-sm">
            <p className="text-amber-400 text-xs">Pending Transfer</p>
            <p className="text-amber-400/70 font-mono text-xs truncate">{config.pendingAdmin.toBase58()}</p>
          </div>
        )}

        {isPendingAdmin ? (
          <button
            onClick={handleAcceptAdmin}
            disabled={submitting !== null}
            className="rounded-md px-4 py-2 text-sm font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting === "Accept Admin Transfer" ? "..." : "Accept Admin Transfer"}
          </button>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={newAdminInput}
              onChange={(e) => setNewAdminInput(e.target.value)}
              placeholder="New admin pubkey"
              className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none font-mono"
            />
            <button
              onClick={handleTransferAdmin}
              disabled={submitting !== null || !newAdminInput}
              className="rounded-md px-3 py-2 text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
            >
              {submitting === "Transfer Admin" ? "..." : "Propose Transfer"}
            </button>
          </div>
        )}
      </div>

      {/* Global Pause */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white/80">Global Pause</h3>
            <p className="text-xs text-white/40 mt-1">
              {config?.isPaused ? "Platform is currently PAUSED" : "Platform is active"}
            </p>
          </div>
          <button
            onClick={handleGlobalPause}
            disabled={submitting !== null}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:bg-white/5 disabled:text-white/20 ${
              config?.isPaused
                ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                : "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
            }`}
          >
            {submitting?.includes("Platform") ? "..." : config?.isPaused ? "Unpause" : "Pause"}
          </button>
        </div>
      </div>

      {/* Config Updates */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-white/80">Configuration</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="block text-xs text-white/40">
              Staleness Threshold (s) — current: {config ? `${config.stalenessThreshold}` : "—"}
            </label>
            <input
              type="number" min="1" value={stalenessInput}
              onChange={(e) => setStalenessInput(e.target.value)}
              placeholder="e.g. 60"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs text-white/40">
              Settlement Staleness (s) — current: {config ? `${config.settlementStaleness}` : "—"}
            </label>
            <input
              type="number" min="1" value={settlementStalenessInput}
              onChange={(e) => setSettlementStalenessInput(e.target.value)}
              placeholder="e.g. 120"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs text-white/40">
              Confidence (bps) — current: {config ? `${config.confidenceBps}` : "—"}
            </label>
            <input
              type="number" min="1" max="10000" value={confidenceInput}
              onChange={(e) => setConfidenceInput(e.target.value)}
              placeholder="e.g. 50"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs text-white/40">
              Operating Reserve ($) — current: {config ? `$${(Number(config.operatingReserve) / 1e6).toFixed(2)}` : "—"}
            </label>
            <input
              type="number" min="0" step="0.01" value={reserveInput}
              onChange={(e) => setReserveInput(e.target.value)}
              placeholder="e.g. 100.00"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs text-white/40">
              Blackout (min) — current: {config ? `${config.settlementBlackoutMinutes}` : "—"}
            </label>
            <input
              type="number" min="0" max="60" value={blackoutInput}
              onChange={(e) => setBlackoutInput(e.target.value)}
              placeholder="e.g. 5"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <button
          onClick={handleUpdateConfig}
          disabled={submitting !== null || (!stalenessInput && !settlementStalenessInput && !confidenceInput && !reserveInput && !blackoutInput)}
          className="rounded-md px-4 py-2 text-sm font-medium bg-accent/20 text-accent hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
        >
          {submitting === "Update Config" ? "..." : "Update Configuration"}
        </button>
      </div>

      {/* Expand Config (one-time migration) */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white/80">Config Status</h3>
            <p className="text-xs text-white/40 mt-1">
              GlobalConfig fully initialized (288 bytes)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
