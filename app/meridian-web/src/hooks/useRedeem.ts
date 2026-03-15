"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "./useAnchorProgram";
import { useTransaction } from "./useTransaction";
import { USDC_MINT } from "./useWalletState";
import {
  findGlobalConfig,
  findTreasury,
  findYesMint,
  findNoMint,
  findUsdcVault,
} from "@/lib/pda";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RedeemParams {
  /** 0 = pair burn, 1 = winner redemption */
  mode: number;
  /** Amount in token lamports (bigint). */
  amount: bigint;
  /** Market public key. */
  marketPublicKey: PublicKey;
  /** Toast description. */
  description: string;
}

export interface TreasuryRedeemParams {
  /** Market public key. */
  marketPublicKey: PublicKey;
  /** Toast description. */
  description: string;
}

interface UseRedeemReturn {
  redeem: (params: RedeemParams) => Promise<string | null>;
  submitting: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Shared redeem transaction builder used by RedeemPanel and PositionsTab.
 * Handles PDA derivation, ATA resolution, transaction building, and
 * query invalidation.
 */
export function useRedeem(): UseRedeemReturn {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const redeem = useCallback(
    async (params: RedeemParams): Promise<string | null> => {
      if (!program || !publicKey) return null;

      setSubmitting(true);
      try {
        const [config] = findGlobalConfig();
        const [yesMint] = findYesMint(params.marketPublicKey);
        const [noMint] = findNoMint(params.marketPublicKey);
        const [usdcVault] = findUsdcVault(params.marketPublicKey);

        const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
        const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

        const tx = await program.methods
          .redeem(params.mode, new BN(params.amount.toString()))
          .accountsPartial({
            user: publicKey,
            config,
            market: params.marketPublicKey,
            yesMint,
            noMint,
            usdcVault,
            userUsdcAta,
            userYesAta,
            userNoAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .transaction();

        const sig = await sendTransaction(tx, {
          description: params.description,
        });

        if (sig) {
          queryClient.invalidateQueries({ queryKey: ["positions"] });
          queryClient.invalidateQueries({ queryKey: ["markets"] });
          queryClient.invalidateQueries({ queryKey: ["walletState"] });
          queryClient.invalidateQueries({ queryKey: ["walletBalance"] });
        }

        return sig;
      } catch {
        // Error handled by useTransaction toast
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [program, publicKey, sendTransaction, queryClient],
  );

  return { redeem, submitting };
}
