"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRedeem } from "@/hooks/useRedeem";
import type { ParsedMarket } from "@/hooks/useMarkets";

interface RedeemPanelProps {
  market: ParsedMarket;
  yesBal: bigint;
  noBal: bigint;
  onSuccess?: () => void;
}

export function RedeemPanel({ market, yesBal, noBal, onSuccess }: RedeemPanelProps) {
  const { publicKey } = useWallet();
  const { redeem, treasuryRedeem, submitting } = useRedeem();

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

  const handlePairBurn = useCallback(async () => {
    if (!canPairBurn) return;
    const sig = await redeem({
      mode: 0,
      amount: pairBurnQty,
      marketPublicKey: market.publicKey,
      description: `Burn ${pairBurnTokens.toFixed(0)} pairs for $${pairBurnTokens.toFixed(2)} USDC`,
    });
    if (sig) onSuccess?.();
  }, [canPairBurn, pairBurnQty, pairBurnTokens, market.publicKey, redeem, onSuccess]);

  const handleWinnerRedeem = useCallback(async () => {
    if (!canWinnerRedeem) return;
    const sig = await redeem({
      mode: 1,
      amount: winnerBal,
      marketPublicKey: market.publicKey,
      description: `Redeem ${winnerTokens.toFixed(0)} ${winnerLabel} tokens`,
    });
    if (sig) onSuccess?.();
  }, [canWinnerRedeem, winnerBal, winnerTokens, winnerLabel, market.publicKey, redeem, onSuccess]);

  const handleTreasuryRedeem = useCallback(async () => {
    if (!canTreasuryRedeem) return;
    const totalTokens = Number(yesBal + noBal) / 1_000_000;
    const sig = await treasuryRedeem({
      marketPublicKey: market.publicKey,
      description: `Treasury redeem ${totalTokens.toFixed(0)} tokens`,
    });
    if (sig) onSuccess?.();
  }, [canTreasuryRedeem, yesBal, noBal, market.publicKey, treasuryRedeem, onSuccess]);

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
