"use client";

import { useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
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

interface MintPairButtonProps {
  market: ParsedMarket;
}

export function MintPairButton({ market }: MintPairButtonProps) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const qtyNum = parseFloat(quantity) || 0;
  const isValidInteger = quantity !== "" && /^\d+$/.test(quantity) && qtyNum > 0;
  const qtyLamports = Math.round(qtyNum * 1_000_000);

  const handleMint = useCallback(async () => {
    if (!program || !publicKey || qtyLamports <= 0 || !isValidInteger) return;
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
        .mintPair(new BN(qtyLamports))
        .accountsPartial({
          user: publicKey,
          config,
          market: market.publicKey,
          yesMint,
          noMint,
          userUsdcAta,
          userYesAta,
          userNoAta,
          usdcVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      await sendTransaction(tx, { description: "Create Pair" });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["markets"] });
      setQuantity("");
      setShowForm(false);
    } catch { /* handled by toast */ }
    finally { setSubmitting(false); }
  }, [program, publicKey, market, qtyLamports, isValidInteger, sendTransaction, queryClient]);

  if (!publicKey || market.isSettled) return null;

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="text-xs text-white/40 hover:text-white/70 transition-colors border border-white/10 rounded-md px-3 py-1.5"
      >
        Create Pairs
      </button>
    );
  }

  const showIntegerError = quantity !== "" && !isValidInteger;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="qty"
          className={`w-20 rounded-md border bg-white/5 px-2 py-1 text-xs text-white focus:outline-none ${showIntegerError ? "border-red-500/50" : "border-white/10"}`}
        />
        <button
          onClick={handleMint}
          disabled={submitting || !isValidInteger}
          className="text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-2 py-1.5 transition-colors disabled:opacity-50"
        >
          {submitting ? "..." : `Create ${qtyNum || 0} pairs ($${qtyNum.toFixed(2)})`}
        </button>
        <button
          onClick={() => setShowForm(false)}
          className="text-xs text-white/30 hover:text-white/50"
        >
          ✕
        </button>
      </div>
      {showIntegerError && (
        <span className="text-[10px] text-red-400">Quantity must be a positive whole number</span>
      )}
    </div>
  );
}
