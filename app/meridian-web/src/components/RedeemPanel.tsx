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

  // Winner redemption: post-settlement, after override window
  const isYesWinner = market.outcome === 1;
  const winnerBal = isYesWinner ? yesBal : noBal;
  const winnerTokens = Number(winnerBal) / 1_000_000;
  const winnerLabel = isYesWinner ? "Yes" : "No";

  const hasValidOutcome = market.outcome === 1 || market.outcome === 2;
  const canWinnerRedeem = market.isSettled && hasValidOutcome && !inOverrideWindow && winnerBal > BigInt(0) && !market.isPaused;

  const handleRedeem = useCallback(
    async () => {
      if (!program || !publicKey || winnerBal <= BigInt(0)) return;
      setSubmitting(true);

      try {
        const [config] = findGlobalConfig();
        const [yesMint] = findYesMint(market.publicKey);
        const [noMint] = findNoMint(market.publicKey);
        const [usdcVault] = findUsdcVault(market.publicKey);

        const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
        const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

        const tx = await program.methods
          .redeem(1, new BN(winnerBal.toString()))
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

        await sendTransaction(tx, { description: `Redeem ${winnerTokens.toFixed(0)} ${winnerLabel} tokens` });

        queryClient.invalidateQueries({ queryKey: ["positions"] });
        queryClient.invalidateQueries({ queryKey: ["markets"] });
        onSuccess?.();
      } catch {
        // Error handled by useTransaction toast
      } finally {
        setSubmitting(false);
      }
    },
    [program, publicKey, market, winnerBal, winnerTokens, winnerLabel, sendTransaction, queryClient, onSuccess],
  );

  if (!publicKey) return null;

  // Not settled or no winning tokens — show guidance if settled
  if (!canWinnerRedeem) {
    if (market.isSettled && !inOverrideWindow && hasValidOutcome) {
      return (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-white/80">Redeem</h3>
          <p className="text-xs text-white/40">
            Market settled — {isYesWinner ? "Yes" : "No"} wins. You have no winning tokens to redeem.
            If you had resting orders, your tokens may still be in escrow. Cancel your orders or wait for the crank to return them.
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
    <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-green-400">
        You Won — {winnerLabel} Wins
      </h3>
      <p className="text-xs text-white/50">
        Burn {winnerTokens.toFixed(0)} {winnerLabel} tokens for ${winnerTokens.toFixed(2)} USDC
      </p>
      <button
        onClick={handleRedeem}
        disabled={submitting}
        className="w-full rounded-md py-2.5 text-sm font-semibold text-white bg-green-500/20 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
      >
        {submitting ? "Redeeming..." : `Redeem $${winnerTokens.toFixed(2)} USDC`}
      </button>
    </div>
  );
}
