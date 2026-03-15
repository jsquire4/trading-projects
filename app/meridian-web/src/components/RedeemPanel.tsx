"use client";

import { useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { USDC_MINT } from "@/hooks/useWalletState";
import {
  findGlobalConfig,
  findTreasury,
  findYesMint,
  findNoMint,
  findUsdcVault,
} from "@/lib/pda";
import type { ParsedMarket } from "@/hooks/useMarkets";

interface RedeemPanelProps {
  market: ParsedMarket;
  yesBal: bigint;
  noBal: bigint;
  onSuccess?: () => void;
}

export function RedeemPanel({ market, yesBal, noBal, onSuccess }: RedeemPanelProps) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const now = Math.floor(Date.now() / 1000);
  const overrideDeadline = Number(market.overrideDeadline);
  const inOverrideWindow = market.isSettled && now < overrideDeadline;

  // Pair burn: available anytime when user holds both Yes AND No
  const pairBurnQty = yesBal < noBal ? yesBal : noBal; // min(yesBal, noBal)
  const canPairBurn = pairBurnQty > BigInt(0);
  const pairBurnTokens = Number(pairBurnQty) / 1_000_000;

  // Winner redemption: post-settlement, after override window
  const isYesWinner = market.outcome === 1;
  const winnerBal = isYesWinner ? yesBal : noBal;
  const winnerTokens = Number(winnerBal) / 1_000_000;
  const winnerLabel = isYesWinner ? "Yes" : "No";

  const hasValidOutcome = market.outcome === 1 || market.outcome === 2;
  const canWinnerRedeem = market.isSettled && hasValidOutcome && !inOverrideWindow && winnerBal > BigInt(0) && !market.isPaused;

  // Treasury redeem: available after market is CLOSED (USDC moved to treasury)
  const canTreasuryRedeem = market.isClosed && (yesBal > BigInt(0) || noBal > BigInt(0));

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["positions"] });
    queryClient.invalidateQueries({ queryKey: ["markets"] });
    queryClient.invalidateQueries({ queryKey: ["walletState"] });
    queryClient.invalidateQueries({ queryKey: ["walletBalance"] });
  }, [queryClient]);

  const buildRedeemTx = useCallback(
    async (mode: number, amount: bigint) => {
      if (!program || !publicKey) return null;

      const [config] = findGlobalConfig();
      const [yesMint] = findYesMint(market.publicKey);
      const [noMint] = findNoMint(market.publicKey);
      const [usdcVault] = findUsdcVault(market.publicKey);

      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
      const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

      return program.methods
        .redeem(mode, new BN(amount.toString()))
        .accountsPartial({
          user: publicKey,
          config,
          market: market.publicKey,
          yesMint,
          noMint,
          usdcVault,
          userUsdcAta,
          userYesAta,
          userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
    },
    [program, publicKey, market],
  );

  const handlePairBurn = useCallback(async () => {
    if (!canPairBurn) return;
    setSubmitting(true);
    try {
      const tx = await buildRedeemTx(0, pairBurnQty);
      if (!tx) return;
      await sendTransaction(tx, { description: `Burn ${pairBurnTokens.toFixed(0)} pairs for $${pairBurnTokens.toFixed(2)} USDC` });
      invalidateAll();
      onSuccess?.();
    } catch {
      // Error handled by useTransaction toast
    } finally {
      setSubmitting(false);
    }
  }, [canPairBurn, pairBurnQty, pairBurnTokens, buildRedeemTx, sendTransaction, invalidateAll, onSuccess]);

  const handleWinnerRedeem = useCallback(async () => {
    if (!canWinnerRedeem) return;
    setSubmitting(true);
    try {
      const tx = await buildRedeemTx(1, winnerBal);
      if (!tx) return;
      await sendTransaction(tx, { description: `Redeem ${winnerTokens.toFixed(0)} ${winnerLabel} tokens` });
      invalidateAll();
      onSuccess?.();
    } catch {
      // Error handled by useTransaction toast
    } finally {
      setSubmitting(false);
    }
  }, [canWinnerRedeem, winnerBal, winnerTokens, winnerLabel, buildRedeemTx, sendTransaction, invalidateAll, onSuccess]);

  const handleTreasuryRedeem = useCallback(async () => {
    if (!canTreasuryRedeem || !program || !publicKey) return;
    setSubmitting(true);
    try {
      const [config] = findGlobalConfig();
      const [treasury] = findTreasury();
      const [yesMint] = findYesMint(market.publicKey);
      const [noMint] = findNoMint(market.publicKey);

      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
      const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

      const tx = await program.methods
        .treasuryRedeem()
        .accountsPartial({
          user: publicKey,
          config,
          market: market.publicKey,
          yesMint,
          noMint,
          treasury,
          userUsdcAta,
          userYesAta,
          userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();

      const totalTokens = Number(yesBal + noBal) / 1_000_000;
      await sendTransaction(tx, { description: `Treasury redeem ${totalTokens.toFixed(0)} tokens` });
      invalidateAll();
      onSuccess?.();
    } catch {
      // Error handled by useTransaction toast
    } finally {
      setSubmitting(false);
    }
  }, [canTreasuryRedeem, program, publicKey, market, yesBal, noBal, sendTransaction, invalidateAll, onSuccess]);

  if (!publicKey) return null;

  // Show nothing if no actions available
  if (!canPairBurn && !canWinnerRedeem && !canTreasuryRedeem) {
    if (market.isSettled && !inOverrideWindow && hasValidOutcome) {
      return (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-white/80">Redeem</h3>
          <p className="text-xs text-white/40">
            Market settled — {isYesWinner ? "Yes" : "No"} wins. You have no winning tokens to redeem.
          </p>
          <p className="text-[10px] text-white/30">
            Some tokens may be held in open orders (escrow). Cancel open orders to free them.
          </p>
        </div>
      );
    }
    if (inOverrideWindow) {
      return (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-yellow-400/80">Settlement Under Review</h3>
          <p className="text-xs text-yellow-400/50">
            Redemptions available at {new Date(overrideDeadline * 1000).toLocaleTimeString()}
          </p>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="space-y-3">
      {/* Pair Burn section — available anytime when holding both tokens */}
      {canPairBurn && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-blue-400">
            Burn Pair for USDC
          </h3>
          <p className="text-xs text-white/50">
            Burn {pairBurnTokens.toFixed(0)} Yes + {pairBurnTokens.toFixed(0)} No tokens for ${pairBurnTokens.toFixed(2)} USDC
          </p>
          <p className="text-[10px] text-white/30">
            Some tokens may be held in open orders (escrow). Cancel open orders to free them.
          </p>
          <button
            onClick={handlePairBurn}
            disabled={submitting}
            className="w-full rounded-md py-2.5 text-sm font-semibold text-white bg-blue-500/20 hover:bg-blue-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting ? "Processing..." : `Burn Pair for $${pairBurnTokens.toFixed(2)} USDC`}
          </button>
        </div>
      )}

      {/* Winner Redeem section — post-settlement only */}
      {canWinnerRedeem && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-green-400">
            You Won — {winnerLabel} Wins
          </h3>
          <p className="text-xs text-white/50">
            Burn {winnerTokens.toFixed(0)} {winnerLabel} tokens for ${winnerTokens.toFixed(2)} USDC
          </p>
          <button
            onClick={handleWinnerRedeem}
            disabled={submitting}
            className="w-full rounded-md py-2.5 text-sm font-semibold text-white bg-green-500/20 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting ? "Redeeming..." : `Redeem $${winnerTokens.toFixed(2)} USDC`}
          </button>
        </div>
      )}

      {/* Treasury Redeem section — after market is CLOSED */}
      {canTreasuryRedeem && (
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-purple-400">
            Treasury Redeem
          </h3>
          <p className="text-xs text-white/50">
            Market is closed. Burn your remaining tokens and receive USDC from the treasury.
            Pairs redeem at $1 each, winning tokens at $1, losing tokens at $0.
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs text-white/40">
            <div>Yes tokens: {(Number(yesBal) / 1_000_000).toFixed(0)}</div>
            <div>No tokens: {(Number(noBal) / 1_000_000).toFixed(0)}</div>
          </div>
          <button
            onClick={handleTreasuryRedeem}
            disabled={submitting}
            className="w-full rounded-md py-2.5 text-sm font-semibold text-white bg-purple-500/20 hover:bg-purple-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting ? "Redeeming..." : "Redeem from Treasury"}
          </button>
        </div>
      )}
    </div>
  );
}
