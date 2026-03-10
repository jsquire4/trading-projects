"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyOrders } from "@/hooks/useMyOrders";
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

interface MyOrdersProps {
  marketKey: string;
}

const SIDE_LABELS: Record<number, string> = {
  0: "Buy Yes",
  1: "Sell Yes",
  2: "Buy No",
};

const SIDE_COLORS: Record<number, string> = {
  0: "text-green-400",
  1: "text-amber-400",
  2: "text-red-400",
};

export function MyOrders({ marketKey }: MyOrdersProps) {
  const { orders, isLoading } = useMyOrders(marketKey);
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(
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

        const tx = await program.methods
          .cancelOrder(priceLevel, new BN(orderId.toString()))
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

  if (!publicKey) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Orders</h3>
        <p className="text-xs text-white/30">Connect wallet to view orders</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-semibold text-white/80 mb-2">My Orders</h3>
        <div className="animate-pulse space-y-2">
          {[1, 2].map((i) => <div key={i} className="h-8 rounded bg-white/10" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white/80 mb-2">
        My Orders {orders.length > 0 && <span className="text-white/40">({orders.length})</span>}
      </h3>
      {orders.length === 0 ? (
        <p className="text-xs text-white/30">No open orders</p>
      ) : (
        <div className="space-y-1.5">
          {orders.map((order) => {
            const idStr = order.orderId.toString();
            const qty = (Number(order.quantity) / 1_000_000).toFixed(0);
            const isCancelling = cancellingId === idStr;

            return (
              <div
                key={idStr}
                className="flex items-center justify-between text-xs bg-white/5 rounded-md px-3 py-2"
              >
                <span className={`font-medium ${SIDE_COLORS[order.side] ?? "text-white/50"}`}>
                  {SIDE_LABELS[order.side] ?? "Unknown"}
                </span>
                <span className="text-white/50 tabular-nums">{qty} @ {order.priceLevel}c</span>
                <button
                  onClick={() => handleCancel(order.orderId, order.priceLevel)}
                  disabled={isCancelling}
                  className="text-red-400/70 hover:text-red-400 disabled:text-white/20 transition-colors text-[11px] font-medium"
                >
                  {isCancelling ? "..." : "Cancel"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
