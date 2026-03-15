"use client";

import { useState, useCallback } from "react";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useFeeVaultBalance } from "@/hooks/useFeeVaultBalance";
import { useTreasuryBalance } from "@/hooks/useTreasuryBalance";
import { findGlobalConfig, findFeeVault, findTreasury, findSolTreasury } from "@/lib/pda";
import { SystemProgram } from "@solana/web3.js";

export function FeesRevenue() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();

  const { data: config } = useGlobalConfig();
  const { data: feeVault } = useFeeVaultBalance();
  const { data: treasury } = useTreasuryBalance();

  const [feeBpsInput, setFeeBpsInput] = useState("");
  const [creationFeeInput, setCreationFeeInput] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);

  const obligations = config ? Number(config.obligations) / 1e6 : 0;
  const reserve = config ? Number(config.operatingReserve) / 1e6 : 0;
  const treasuryBal = treasury?.balance ?? 0;
  const available = Math.max(0, treasuryBal - obligations - reserve);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["global-config"] });
    queryClient.invalidateQueries({ queryKey: ["fee-vault-balance"] });
    queryClient.invalidateQueries({ queryKey: ["treasury-balance"] });
  }, [queryClient]);

  const handleUpdateFeeBps = useCallback(async () => {
    if (!program || !publicKey || !feeBpsInput) return;
    const bps = parseInt(feeBpsInput, 10);
    if (isNaN(bps) || bps < 0 || bps > 1000) return;

    setSubmitting("fee-bps");
    try {
      const [configAddr] = findGlobalConfig();
      const tx = await program.methods
        .updateFeeBps(bps)
        .accountsPartial({ admin: publicKey, config: configAddr })
        .transaction();
      await sendTransaction(tx, { description: "Update Fee BPS" });
      invalidateAll();
      setFeeBpsInput("");
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, feeBpsInput, sendTransaction, invalidateAll]);

  const handleUpdateCreationFee = useCallback(async () => {
    if (!program || !publicKey || !creationFeeInput) return;
    const parsed = parseFloat(creationFeeInput);
    if (isNaN(parsed) || parsed < 0) return;
    const lamports = new BN(Math.round(parsed * 1_000_000));

    setSubmitting("creation-fee");
    try {
      const [configAddr] = findGlobalConfig();
      const tx = await program.methods
        .updateStrikeCreationFee(lamports)
        .accountsPartial({ admin: publicKey, config: configAddr })
        .transaction();
      await sendTransaction(tx, { description: "Update Strike Creation Fee" });
      invalidateAll();
      setCreationFeeInput("");
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, creationFeeInput, sendTransaction, invalidateAll]);

  const handleWithdrawFees = useCallback(async () => {
    if (!program || !publicKey || !config) return;

    setSubmitting("withdraw-fees");
    try {
      const [configAddr] = findGlobalConfig();
      const [feeVaultAddr] = findFeeVault();
      const adminUsdcAta = await getAssociatedTokenAddress(config.usdcMint, publicKey);
      const tx = await program.methods
        .withdrawFees()
        .accountsPartial({
          admin: publicKey,
          config: configAddr,
          feeVault: feeVaultAddr,
          adminUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      await sendTransaction(tx, { description: "Withdraw Fees" });
      invalidateAll();
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, config, sendTransaction, invalidateAll]);

  const handleWithdrawTreasury = useCallback(async () => {
    if (!program || !publicKey || !config || !withdrawAmount) return;
    const parsed = parseFloat(withdrawAmount);
    if (isNaN(parsed) || parsed <= 0 || parsed > available) return;
    const lamports = new BN(Math.round(parsed * 1_000_000));

    setSubmitting("withdraw-treasury");
    try {
      const [configAddr] = findGlobalConfig();
      const [treasuryAddr] = findTreasury();
      const [solTreasuryAddr] = findSolTreasury();
      const adminUsdcAta = await getAssociatedTokenAddress(config.usdcMint, publicKey);
      const tx = await program.methods
        .withdrawTreasury(lamports, 0) // mode 0 = USDC
        .accountsPartial({
          admin: publicKey,
          config: configAddr,
          treasury: treasuryAddr,
          adminUsdcAta,
          solTreasury: solTreasuryAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      await sendTransaction(tx, { description: "Withdraw Treasury" });
      invalidateAll();
      setWithdrawAmount("");
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, config, withdrawAmount, available, sendTransaction, invalidateAll]);

  return (
    <div className="space-y-4">
      {/* Fee Configuration */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-white/80">Fee Configuration</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Fee BPS */}
          <div className="space-y-2">
            <label className="block text-xs text-white/40">
              Protocol Fee — current: {config?.feeBps ?? "—"} bps
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                max="1000"
                value={feeBpsInput}
                onChange={(e) => setFeeBpsInput(e.target.value)}
                placeholder="e.g. 50"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
              />
              <button
                onClick={handleUpdateFeeBps}
                disabled={submitting !== null || !feeBpsInput}
                className="rounded-md px-3 py-2 text-xs font-medium bg-accent/20 text-accent hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
              >
                {submitting === "fee-bps" ? "..." : "Update"}
              </button>
            </div>
          </div>

          {/* Strike Creation Fee */}
          <div className="space-y-2">
            <label className="block text-xs text-white/40">
              Strike Creation Fee — current: ${config ? (Number(config.strikeCreationFee) / 1e6).toFixed(2) : "—"}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="0.01"
                value={creationFeeInput}
                onChange={(e) => setCreationFeeInput(e.target.value)}
                placeholder="e.g. 1.00"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
              />
              <button
                onClick={handleUpdateCreationFee}
                disabled={submitting !== null || !creationFeeInput}
                className="rounded-md px-3 py-2 text-xs font-medium bg-accent/20 text-accent hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
              >
                {submitting === "creation-fee" ? "..." : "Update"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Fee Vault Withdrawal */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 card-accent-green space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white/80">Fee Vault</h3>
            <p className="text-lg font-mono font-semibold text-white tabular-nums mt-1">
              ${feeVault?.balance.toFixed(2) ?? "0.00"}
            </p>
          </div>
          <button
            onClick={handleWithdrawFees}
            disabled={submitting !== null || !feeVault || feeVault.balance === 0}
            className="rounded-md px-4 py-2 text-sm font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting === "withdraw-fees" ? "..." : "Withdraw All"}
          </button>
        </div>
      </div>

      {/* Treasury Withdrawal */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 card-accent-blue space-y-3">
        <h3 className="text-sm font-semibold text-white/80">Treasury</h3>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-white/40 text-xs">Balance</p>
            <p className="text-white font-mono tabular-nums">${treasuryBal.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Obligations</p>
            <p className="text-white font-mono tabular-nums">${obligations.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs">Available</p>
            <p className="text-white font-mono tabular-nums">${available.toFixed(2)}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder={`Max: $${available.toFixed(2)}`}
            className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
          />
          <button
            onClick={handleWithdrawTreasury}
            disabled={submitting !== null || !withdrawAmount || available <= 0}
            className="rounded-md px-4 py-2 text-sm font-medium bg-accent/20 text-accent hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting === "withdraw-treasury" ? "..." : "Withdraw"}
          </button>
        </div>
        {available <= 0 && treasuryBal > 0 && (
          <p className="text-[10px] text-amber-400">
            No surplus available — all funds are reserved for obligations and operating reserve.
          </p>
        )}
      </div>
    </div>
  );
}
