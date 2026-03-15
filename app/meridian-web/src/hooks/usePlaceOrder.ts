"use client";

import { useCallback } from "react";
import { PublicKey, Transaction, AccountMeta, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAnchorProgram } from "./useAnchorProgram";
import { useTransaction } from "./useTransaction";
import { Side, type ActiveOrder } from "@/lib/orderbook";
import { USDC_MINT } from "./useWalletState";
import {
  findGlobalConfig,
  findOrderBook,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findYesMint,
  findNoMint,
} from "@/lib/pda";
import type { OrderBookData } from "./useMarkets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrderSide = "buy-yes" | "sell-yes" | "sell-no" | "buy-no";

export interface PlaceOrderParams {
  marketPubkey: PublicKey;
  marketKey: string;
  side: OrderSide;
  orderType: "limit" | "market";
  effectivePrice: number | null;
  quantityLamports: number;
  orderBookData: OrderBookData | null | undefined;
}

interface UsePlaceOrderReturn {
  placeOrder: (params: PlaceOrderParams) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes":
      return 0;
    case "sell-yes":
    case "buy-no":
      return 1;
    case "sell-no":
      return 2;
  }
}

/**
 * Build remaining_accounts for a Buy-No order's Sell-Yes leg.
 * Matches USDC bids and No-backed bids that the Yes sell would fill.
 */
function buildBuyNoMakerAccounts(
  orderBookData: OrderBookData,
  yesSellPrice: number,
  yesMint: PublicKey,
  maxFills: number,
): AccountMeta[] {
  const makerAccounts: AccountMeta[] = [];
  const orders = orderBookData.raw.orders;
  const usdcBids = orders.filter(
    (o) => o.side === Side.UsdcBid && o.priceLevel >= yesSellPrice,
  );
  const noBids = orders.filter(
    (o) => o.side === Side.NoBackedBid && o.priceLevel <= 100 - yesSellPrice,
  );

  const allBids: { order: ActiveOrder; isMerge: boolean }[] = [];
  for (let level = 99; level >= 1; level--) {
    for (const o of usdcBids.filter((b) => b.priceLevel === level)) {
      allBids.push({ order: o, isMerge: false });
    }
    for (const o of noBids.filter((b) => b.priceLevel === level)) {
      allBids.push({ order: o, isMerge: true });
    }
  }

  for (const { order, isMerge } of allBids) {
    if (makerAccounts.length >= maxFills) break;
    const makerAta = isMerge
      ? getAssociatedTokenAddressSync(USDC_MINT, order.owner)
      : getAssociatedTokenAddressSync(yesMint, order.owner);
    makerAccounts.push({ pubkey: makerAta, isSigner: false, isWritable: true });
  }

  return makerAccounts;
}

/**
 * Build remaining_accounts for standard order sides (buy-yes, sell-yes, sell-no).
 */
function buildStandardMakerAccounts(
  orderBookData: OrderBookData,
  sideU8: number,
  priceU8: number,
  yesMint: PublicKey,
  maxFills: number,
): AccountMeta[] {
  const makerAccounts: AccountMeta[] = [];
  const orders = orderBookData.raw.orders;
  let matchableOrders: { order: ActiveOrder; isMerge: boolean }[] = [];

  if (sideU8 === Side.UsdcBid) {
    // Buy Yes: matches against Yes asks
    matchableOrders = orders
      .filter((o) => o.side === Side.YesAsk && o.priceLevel <= priceU8)
      .sort((a, b) => a.priceLevel - b.priceLevel)
      .map((o) => ({ order: o, isMerge: false }));
  } else if (sideU8 === Side.YesAsk) {
    // Sell Yes: matches against USDC bids AND No-backed bids
    const usdcBids = orders.filter(
      (o) => o.side === Side.UsdcBid && o.priceLevel >= priceU8,
    );
    const noBids = orders.filter(
      (o) => o.side === Side.NoBackedBid && o.priceLevel <= 100 - priceU8,
    );
    const allBids: { order: ActiveOrder; isMerge: boolean }[] = [];
    for (let level = 99; level >= 1; level--) {
      for (const o of usdcBids.filter((b) => b.priceLevel === level)) {
        allBids.push({ order: o, isMerge: false });
      }
      for (const o of noBids.filter((b) => b.priceLevel === level)) {
        allBids.push({ order: o, isMerge: true });
      }
    }
    matchableOrders = allBids;
  } else if (sideU8 === Side.NoBackedBid) {
    // Sell No: matches against Yes asks (merge)
    const maxYesAsk = 100 - priceU8;
    matchableOrders = orders
      .filter((o) => o.side === Side.YesAsk && o.priceLevel <= maxYesAsk)
      .sort((a, b) => a.priceLevel - b.priceLevel)
      .map((o) => ({ order: o, isMerge: true }));
  }

  for (const { order, isMerge } of matchableOrders) {
    if (makerAccounts.length >= maxFills) break;
    let makerAta: PublicKey;
    if (sideU8 === Side.YesAsk && !isMerge) {
      makerAta = getAssociatedTokenAddressSync(yesMint, order.owner);
    } else {
      makerAta = getAssociatedTokenAddressSync(USDC_MINT, order.owner);
    }
    makerAccounts.push({ pubkey: makerAta, isSigner: false, isWritable: true });
  }

  return makerAccounts;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Extracts the transaction-building logic from OrderForm into a reusable hook.
 * Handles all four order sides including atomic Buy-No (mint pair + sell Yes).
 */
export function usePlaceOrder(): UsePlaceOrderReturn {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey: walletPublicKey } = useWallet();
  const queryClient = useQueryClient();

  const placeOrder = useCallback(
    async (params: PlaceOrderParams): Promise<string | null> => {
      const {
        marketPubkey,
        marketKey,
        side,
        orderType,
        effectivePrice,
        quantityLamports,
        orderBookData,
      } = params;

      if (!program || !walletPublicKey) return null;

      const user = walletPublicKey;
      const [config] = findGlobalConfig();
      const [orderBookPda] = findOrderBook(marketPubkey);
      const [usdcVault] = findUsdcVault(marketPubkey);
      const [escrowVault] = findEscrowVault(marketPubkey);
      const [yesEscrow] = findYesEscrow(marketPubkey);
      const [noEscrow] = findNoEscrow(marketPubkey);
      const [yesMint] = findYesMint(marketPubkey);
      const [noMint] = findNoMint(marketPubkey);

      // Derive user ATAs
      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, user);
      const userYesAta = await getAssociatedTokenAddress(yesMint, user);
      const userNoAta = await getAssociatedTokenAddress(noMint, user);

      // Idempotent ATA creation
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userNoAta, user, noMint));

      const maxFills = 10;

      if (side === "buy-no") {
        // Atomic Buy No: mint pair + sell Yes + (optional) redeem cleanup
        const mintPairIx = await program.methods
          .mintPair(new BN(quantityLamports))
          .accountsPartial({
            user,
            config,
            market: marketPubkey,
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
          .instruction();
        tx.add(mintPairIx);

        const noPrice = orderType === "market" ? 1 : effectivePrice!;
        const yesSellPrice = orderType === "market" ? 1 : 100 - noPrice;
        const orderTypeU8 = orderType === "limit" ? 1 : 0;

        const makerAccounts = orderBookData
          ? buildBuyNoMakerAccounts(orderBookData, yesSellPrice, yesMint, maxFills)
          : [];

        const sellYesIx = await program.methods
          .placeOrder(1, yesSellPrice, new BN(quantityLamports), orderTypeU8, maxFills)
          .accountsPartial({
            user,
            config,
            market: marketPubkey,
            orderBook: orderBookPda,
            usdcVault,
            escrowVault,
            yesEscrow,
            noEscrow,
            yesMint,
            noMint,
            userUsdcAta,
            userYesAta,
            userNoAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(makerAccounts)
          .instruction();
        tx.add(sellYesIx);

        // For market orders, add pair-burn cleanup
        if (orderType === "market") {
          const redeemIx = await program.methods
            .redeem(0, new BN(quantityLamports))
            .accountsPartial({
              user,
              config,
              market: marketPubkey,
              yesMint,
              noMint,
              usdcVault,
              userUsdcAta,
              userYesAta,
              userNoAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();
          tx.add(redeemIx);
        }

        const signature = await sendTransaction(tx, { description: "Buy No (Atomic)" });
        if (signature) {
          queryClient.invalidateQueries({ queryKey: ["positions"] });
          queryClient.invalidateQueries({ queryKey: ["order-book", marketKey] });
          queryClient.invalidateQueries({ queryKey: ["cost-basis"] });
        }
        return signature;
      }

      // Standard order flow (buy-yes, sell-yes, sell-no)
      const sideU8 = sideToU8(side);
      const priceU8 =
        orderType === "market"
          ? side === "buy-yes"
            ? 99
            : 1
          : effectivePrice!;
      const orderTypeU8 = orderType === "limit" ? 1 : 0;

      const makerAccounts = orderBookData
        ? buildStandardMakerAccounts(orderBookData, sideU8, priceU8, yesMint, maxFills)
        : [];

      const placeOrderIx = await program.methods
        .placeOrder(sideU8, priceU8, new BN(quantityLamports), orderTypeU8, maxFills)
        .accountsPartial({
          user,
          config,
          market: marketPubkey,
          orderBook: orderBookPda,
          usdcVault,
          escrowVault,
          yesEscrow,
          noEscrow,
          yesMint,
          noMint,
          userUsdcAta,
          userYesAta,
          userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(makerAccounts)
        .instruction();
      tx.add(placeOrderIx);

      const sideLabel = side
        .replace("-", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const signature = await sendTransaction(tx, {
        description: `Place ${sideLabel} Order`,
      });
      if (signature) {
        queryClient.invalidateQueries({ queryKey: ["positions"] });
        queryClient.invalidateQueries({ queryKey: ["order-book", marketKey] });
        queryClient.invalidateQueries({ queryKey: ["cost-basis"] });
      }
      return signature;
    },
    [program, walletPublicKey, sendTransaction, queryClient],
  );

  return { placeOrder };
}
