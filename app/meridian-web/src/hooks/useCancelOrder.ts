"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { USDC_MINT } from "@/hooks/useWalletState";
import {
  findGlobalConfig,
  findOrderBook,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findYesMint,
  findNoMint,
} from "@/lib/pda";

export function useCancelOrder(marketKey: string) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const cancelOrder = useCallback(
    async (orderId: bigint, priceLevel: number) => {
      if (!program || !publicKey) return;
      const idStr = orderId.toString();
      setCancellingId(idStr);

      try {
        const marketPubkey = new PublicKey(marketKey);
        const [config] = findGlobalConfig();
        const [orderBook] = findOrderBook(marketPubkey);
        const [escrowVault] = findEscrowVault(marketPubkey);
        const [yesEscrow] = findYesEscrow(marketPubkey);
        const [noEscrow] = findNoEscrow(marketPubkey);
        const [yesMint] = findYesMint(marketPubkey);
        const [noMint] = findNoMint(marketPubkey);

        const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
        const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

        // Ensure all 3 ATAs exist before cancelling (user may not hold all token types)
        const tx = await program.methods
          .cancelOrder(priceLevel, new BN(orderId.toString()))
          .preInstructions([
            createAssociatedTokenAccountIdempotentInstruction(publicKey, userUsdcAta, publicKey, USDC_MINT),
            createAssociatedTokenAccountIdempotentInstruction(publicKey, userYesAta, publicKey, yesMint),
            createAssociatedTokenAccountIdempotentInstruction(publicKey, userNoAta, publicKey, noMint),
          ])
          .accountsPartial({
            user: publicKey,
            config,
            market: marketPubkey,
            orderBook,
            escrowVault,
            yesEscrow,
            noEscrow,
            userUsdcAta,
            userYesAta,
            userNoAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .transaction();

        await sendTransaction(tx, { description: "Cancel Order" });
        queryClient.invalidateQueries({ queryKey: ["orderbook"] });
        queryClient.invalidateQueries({ queryKey: ["myOrders"] });
        queryClient.invalidateQueries({ queryKey: ["positions"] });
      } catch {
        // Error handled by useTransaction toast
      } finally {
        setCancellingId(null);
      }
    },
    [program, publicKey, marketKey, sendTransaction, queryClient],
  );

  return { cancelOrder, cancellingId };
}
