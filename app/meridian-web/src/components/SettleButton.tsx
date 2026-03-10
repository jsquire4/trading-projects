"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { findGlobalConfig } from "@/lib/pda";
import type { ParsedMarket } from "@/hooks/useMarkets";

interface SettleButtonProps {
  market: ParsedMarket;
  onSuccess?: () => void;
}

export function SettleButton({ market, onSuccess }: SettleButtonProps) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const now = Math.floor(Date.now() / 1000);
  const closeUnix = Number(market.marketCloseUnix);
  const canSettle = !market.isSettled && now > closeUnix && !!publicKey;

  const handleSettle = useCallback(async () => {
    if (!program || !publicKey || !canSettle) return;
    setSubmitting(true);
    try {
      const [config] = findGlobalConfig();
      const tx = await program.methods.settleMarket()
        .accountsPartial({
          caller: publicKey,
          config,
          market: market.publicKey,
          oracleFeed: market.oracleFeed,
        }).transaction();
      await sendTransaction(tx, { description: `Settle ${market.ticker}` });
      queryClient.invalidateQueries({ queryKey: ["markets"] });
      onSuccess?.();
    } catch { /* handled by toast */ }
    finally { setSubmitting(false); }
  }, [program, publicKey, canSettle, market, sendTransaction, queryClient, onSuccess]);

  if (!canSettle) return null;

  return (
    <button
      onClick={handleSettle}
      disabled={submitting}
      className="text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
    >
      {submitting ? "Settling..." : "Settle Market"}
    </button>
  );
}
