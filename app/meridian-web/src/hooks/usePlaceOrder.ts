"use client";

import { useCallback } from "react";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  AccountMeta,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
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
  /** Market's ALT address for versioned transactions. Pubkey.default = no ALT. */
  altAddress?: PublicKey;
}

interface UsePlaceOrderReturn {
  placeOrder: (params: PlaceOrderParams) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max fills per place_order instruction. With ALT, each remaining_account
 * compresses from 32 bytes to 1 byte, allowing 50+ fills per tx.
 * Without ALT, falls back to 10 (legacy tx size limit).
 */
const MAX_FILLS_WITH_ALT = 50;
const MAX_FILLS_WITHOUT_ALT = 10;

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

/**
 * Fetch an Address Lookup Table account. Returns null if not found or default pubkey.
 */
async function fetchALT(
  connection: ReturnType<typeof useConnection>["connection"],
  altAddress: PublicKey | undefined,
): Promise<AddressLookupTableAccount | null> {
  if (!altAddress || altAddress.equals(PublicKey.default)) return null;

  try {
    const result = await connection.getAddressLookupTable(altAddress);
    return result.value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Builds versioned transactions with ALT support for order placement.
 * Falls back to legacy transactions if no ALT is available.
 * With ALT: up to 50 fills per instruction. Without: up to 10.
 */
export function usePlaceOrder(): UsePlaceOrderReturn {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey: walletPublicKey } = useWallet();
  const { connection } = useConnection();
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
        altAddress,
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

      // Fetch ALT for versioned transaction
      const alt = await fetchALT(connection, altAddress);
      const maxFills = alt ? MAX_FILLS_WITH_ALT : MAX_FILLS_WITHOUT_ALT;

      // Build instructions
      const instructions: TransactionInstruction[] = [];

      // Idempotent ATA creation
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT));
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userNoAta, user, noMint));

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
        instructions.push(mintPairIx);

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
        instructions.push(sellYesIx);

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
          instructions.push(redeemIx);
        }

        const tx = await buildVersionedTx(connection, user, instructions, alt);
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
      instructions.push(placeOrderIx);

      const sideLabel = side
        .replace("-", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

      const tx = await buildVersionedTx(connection, user, instructions, alt);
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
    [program, walletPublicKey, connection, sendTransaction, queryClient],
  );

  return { placeOrder };
}

// ---------------------------------------------------------------------------
// Versioned transaction builder
// ---------------------------------------------------------------------------

async function buildVersionedTx(
  connection: ReturnType<typeof useConnection>["connection"],
  payer: PublicKey,
  instructions: TransactionInstruction[],
  alt: AddressLookupTableAccount | null,
): Promise<VersionedTransaction> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const lookupTables = alt ? [alt] : [];

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  // Note: lastValidBlockHeight is used by useTransaction for confirmation
  // but VersionedTransaction doesn't store it — useTransaction handles this
  return tx;
}
