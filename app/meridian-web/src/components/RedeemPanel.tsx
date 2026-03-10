"use client";

import { useState, useCallback, useMemo } from "react";
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
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const now = Math.floor(Date.now() / 1000);
  const overrideDeadline = Number(market.overrideDeadline);
  const inOverrideWindow = market.isSettled && now < overrideDeadline;

  // Pair burn: min(yesBal, noBal) available anytime
  const maxPairBurn = yesBal < noBal ? yesBal : noBal;
  const maxPairBurnNum = Number(maxPairBurn) / 1_000_000;

  // Winner redemption: post-settlement, after override window
  const isYesWinner = market.outcome === 1;
  const winnerBal = isYesWinner ? yesBal : noBal;
  const maxWinnerNum = Number(winnerBal) / 1_000_000;

  const canPairBurn = maxPairBurn > BigInt(0) && !market.isPaused;
  const canWinnerRedeem = market.isSettled && !inOverrideWindow && winnerBal > BigInt(0) && !market.isPaused;

  const qtyNum = parseFloat(quantity) || 0;
  const qtyLamports = Math.round(qtyNum * 1_000_000);

  const handleRedeem = useCallback(
    async (mode: number) => {
      if (!program || !publicKey || qtyLamports <= 0) return;
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
          .redeem(mode, new BN(qtyLamports))
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

        const label = mode === 0 ? "Pair Burn" : "Winner Redemption";
        await sendTransaction(tx, { description: label });

        queryClient.invalidateQueries({ queryKey: ["positions"] });
        queryClient.invalidateQueries({ queryKey: ["markets"] });
        setQuantity("");
        onSuccess?.();
      } catch {
        // Error handled by useTransaction toast
      } finally {
        setSubmitting(false);
      }
    },
    [program, publicKey, market, qtyLamports, sendTransaction, queryClient, onSuccess],
  );

  if (!publicKey) return null;
  if (!canPairBurn && !canWinnerRedeem) return null;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-white/80">Redeem</h3>

      <div>
        <label className="block text-xs text-white/40 mb-1">Quantity</label>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="0"
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
        />
      </div>

      {canPairBurn && (
        <div>
          <div className="text-[11px] text-white/40 mb-1">
            Pair Burn — burn {qtyNum || "?"} Yes + {qtyNum || "?"} No → ${(qtyNum || 0).toFixed(2)} USDC
          </div>
          <button
            onClick={() => handleRedeem(0)}
            disabled={submitting || qtyNum <= 0 || qtyNum > maxPairBurnNum}
            className="w-full rounded-md py-2 text-xs font-medium text-white bg-accent/20 hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting ? "Burning..." : `Burn Pairs (max ${maxPairBurnNum.toFixed(0)})`}
          </button>
        </div>
      )}

      {market.isSettled && (
        <div>
          {inOverrideWindow ? (
            <div className="text-[11px] text-yellow-400/70">
              Override window active — redemptions available at{" "}
              {new Date(overrideDeadline * 1000).toLocaleTimeString()}
            </div>
          ) : canWinnerRedeem ? (
            <>
              <div className="text-[11px] text-white/40 mb-1">
                Winner Redeem — burn {qtyNum || "?"} {isYesWinner ? "Yes" : "No"} → ${(qtyNum || 0).toFixed(2)} USDC
              </div>
              <button
                onClick={() => handleRedeem(1)}
                disabled={submitting || qtyNum <= 0 || qtyNum > maxWinnerNum}
                className="w-full rounded-md py-2 text-xs font-medium text-white bg-green-500/20 hover:bg-green-500/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
              >
                {submitting ? "Redeeming..." : `Redeem Winners (max ${maxWinnerNum.toFixed(0)})`}
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
