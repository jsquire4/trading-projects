"use client";

import { useMemo, useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMarkets } from "@/hooks/useMarkets";
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

const SIDE_LABELS: Record<number, string> = { 0: "Buy Yes", 1: "Sell Yes", 2: "Buy No" };
const SIDE_COLORS: Record<number, string> = { 0: "text-green-400", 1: "text-amber-400", 2: "text-red-400" };

function MarketOrders({ marketKey, ticker, strike }: { marketKey: string; ticker: string; strike: number }) {
  const { orders, isLoading } = useMyOrders(marketKey);
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(async (orderId: bigint, priceLevel: number) => {
    if (!program || !publicKey) return;
    setCancellingId(orderId.toString());
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
          user: publicKey, config, market: marketPubkey, orderBook,
          escrowVault, yesEscrow, noEscrow,
          userUsdcAta, userYesAta, userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      await sendTransaction(tx, { description: "Cancel Order" });
      queryClient.invalidateQueries({ queryKey: ["orderbook"] });
      queryClient.invalidateQueries({ queryKey: ["myOrders"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
    } catch { /* handled by toast */ } finally { setCancellingId(null); }
  }, [program, publicKey, marketKey, sendTransaction, queryClient]);

  if (isLoading || orders.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-xs text-white/40 font-medium px-1">
        {ticker} ${strike.toFixed(0)}
      </div>
      {orders.map((order) => {
        const idStr = order.orderId.toString();
        const qty = (Number(order.quantity) / 1_000_000).toFixed(0);
        return (
          <div key={idStr} className="flex items-center justify-between text-xs bg-white/5 rounded-md px-3 py-2">
            <span className={`font-medium ${SIDE_COLORS[order.side] ?? "text-white/50"}`}>
              {SIDE_LABELS[order.side] ?? "Unknown"}
            </span>
            <span className="text-white/50 tabular-nums">{qty} @ {order.priceLevel}c</span>
            <button
              onClick={() => handleCancel(order.orderId, order.priceLevel)}
              disabled={cancellingId === idStr}
              className="text-red-400/70 hover:text-red-400 disabled:text-white/20 transition-colors text-[11px] font-medium"
            >
              {cancellingId === idStr ? "..." : "Cancel"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function OpenOrdersTab() {
  const { data: markets = [], isLoading } = useMarkets();
  const activeMarkets = useMemo(
    () => markets.filter((m) => !m.isSettled && !m.isClosed),
    [markets],
  );

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-white/5 border border-white/10 animate-pulse" />;
  }

  if (activeMarkets.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
        <p className="text-white/50 text-sm">No active markets</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {activeMarkets.map((m) => (
        <MarketOrders
          key={m.publicKey.toBase58()}
          marketKey={m.publicKey.toBase58()}
          ticker={m.ticker}
          strike={Number(m.strikePrice) / 1_000_000}
        />
      ))}
    </div>
  );
}
