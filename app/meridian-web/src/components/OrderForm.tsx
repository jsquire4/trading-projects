"use client";

import { useState, useMemo, useCallback } from "react";
import { PublicKey, Transaction, AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useNetwork } from "@/hooks/useNetwork";
import { usePositions } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { Side, type ActiveOrder } from "@/lib/orderbook";
import { USDC_MINT } from "@/hooks/useWalletState";
import { TradeConfirmationModal } from "@/components/TradeConfirmationModal";
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

// Side encoding (on-chain has only 3 sides):
//   0 = Buy Yes (bid on yes tokens)
//   1 = Sell Yes (ask yes tokens)
//   2 = Buy No / Sell No (no-backed bid — both map to side 2 on-chain)
// Order type: 0 = Limit, 1 = Market
type OrderSide = "buy-yes" | "sell-yes" | "buy-no" | "sell-no";

interface OrderFormProps {
  marketKey: string;
  ticker: string;
  strikePrice: number;
}

const LAMPORTS_PER_TOKEN = 1_000_000;

function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes":
      return 0;
    case "sell-yes":
      return 1;
    case "sell-no":
      // Sell No = No-backed bid (side 2) — user offers No tokens at stated price
      return 2;
    case "buy-no":
      // No-backed bid (side 2)
      return 2;
  }
}

export function OrderForm({ marketKey, ticker, strikePrice }: OrderFormProps) {
  const [side, setSide] = useState<OrderSide>("buy-yes");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState<string>("50");
  const [quantity, setQuantity] = useState<string>("1");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey: walletPublicKey } = useWallet();
  const { isMainnet } = useNetwork();
  const { data: positions = [] } = usePositions();

  const marketPubkey = useMemo(() => new PublicKey(marketKey), [marketKey]);
  const { data: orderBookData } = useOrderBook(marketKey);

  // Position constraint: can't Buy Yes while holding No, or Buy No while holding Yes
  const currentPosition = useMemo(() => {
    return positions.find((p) => p.market.publicKey.toBase58() === marketKey);
  }, [positions, marketKey]);

  const positionConflict = useMemo((): string | null => {
    if (!currentPosition) return null;
    if ((side === "buy-yes") && currentPosition.noBal > BigInt(0)) {
      return "You hold No tokens for this strike. Sell your No position first.";
    }
    if ((side === "buy-no") && currentPosition.yesBal > BigInt(0)) {
      return "You hold Yes tokens for this strike. Sell your Yes position first.";
    }
    return null;
  }, [side, currentPosition]);

  // Check if the order book has liquidity on the side the user needs
  const marketOrderWarning = useMemo((): string | null => {
    if (orderType !== "market") return null;
    if (!orderBookData) return null;
    const yesView = orderBookData.yesView;
    // Buy Yes = needs asks on Yes book. Sell Yes = needs bids on Yes book.
    // Buy No / Sell No (side 2) = needs asks on No book / bids on No book.
    if (side === "buy-yes" && (yesView.bestAsk === null)) {
      return "No sell orders on the book — market buy can't fill. Use a limit order instead.";
    }
    if (side === "sell-yes" && (yesView.bestBid === null)) {
      return "No buy orders on the book — market sell can't fill. Use a limit order instead.";
    }
    const noView = orderBookData.noView;
    if (side === "buy-no" && (noView.bestAsk === null)) {
      return "No sell orders on the No book — market buy can't fill. Use a limit order instead.";
    }
    if (side === "sell-no" && (noView.bestBid === null)) {
      return "No buy orders on the No book — market sell can't fill. Use a limit order instead.";
    }
    return null;
  }, [orderType, orderBookData, side]);

  const effectivePrice = useMemo(() => {
    if (orderType === "market") return null;
    const p = parseInt(price, 10);
    if (isNaN(p) || p < 1 || p > 99) return null;
    return p;
  }, [price, orderType]);

  const quantityLamports = useMemo(() => {
    const q = parseFloat(quantity);
    if (isNaN(q) || q < 1) return null;
    return Math.floor(q * LAMPORTS_PER_TOKEN);
  }, [quantity]);

  // For market orders, use best ask (buys) or best bid (sells) from the order book
  const marketPrice = useMemo((): number | null => {
    if (orderType !== "market" || !orderBookData) return null;
    const yesView = orderBookData.yesView;
    const noView = orderBookData.noView;
    if (side === "buy-yes") return yesView.bestAsk;
    if (side === "sell-yes") return yesView.bestBid;
    if (side === "buy-no") return noView.bestAsk;
    if (side === "sell-no") return noView.bestBid;
    return null;
  }, [orderType, orderBookData, side]);

  const displayPrice = effectivePrice ?? marketPrice;

  const estimatedCost = useMemo(() => {
    if (!quantityLamports || !displayPrice) return null;
    return (displayPrice / 100) * (quantityLamports / LAMPORTS_PER_TOKEN);
  }, [quantityLamports, displayPrice]);

  const isValid = useMemo(() => {
    if (!quantityLamports || quantityLamports < LAMPORTS_PER_TOKEN) return false;
    if (orderType === "limit" && !effectivePrice) return false;
    if (!walletPublicKey) return false;
    return true;
  }, [quantityLamports, effectivePrice, orderType, walletPublicKey]);

  const handleSubmitDirect = useCallback(async () => {
    if (!isValid || !program || !walletPublicKey || submitting) return;
    setSubmitting(true);

    try {
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

      // Idempotent ATA creation — no-ops if accounts already exist, creates if missing
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userNoAta, user, noMint));

      const sideU8 = sideToU8(side);
      // Market orders: use worst acceptable price (99 for buys, 1 for sells)
      const isBuyFlag = side === "buy-yes" || side === "buy-no";
      const priceU8 = orderType === "market" ? (isBuyFlag ? 99 : 1) : effectivePrice!;
      const orderTypeU8 = orderType === "limit" ? 1 : 0;
      const maxFills = 10;

      // Build remaining_accounts: maker ATAs needed for fill settlement.
      // For each potential fill, the program needs the maker's destination ATA:
      //   Buy Yes (side=0)  fills Yes asks  → maker's USDC ATA
      //   Sell Yes (side=1) fills USDC bids → maker's Yes ATA
      //   Buy No  (side=2)  fills Yes asks  → maker's USDC ATA
      const makerAccounts: AccountMeta[] = [];
      if (orderBookData) {
        const orders = orderBookData.raw.orders;
        let matchableOrders: ActiveOrder[] = [];

        if (sideU8 === Side.UsdcBid) {
          // Buy Yes: matches against Yes asks at price <= our price
          matchableOrders = orders
            .filter((o) => o.side === Side.YesAsk && o.priceLevel <= priceU8)
            .sort((a, b) => a.priceLevel - b.priceLevel); // best (lowest) ask first
        } else if (sideU8 === Side.YesAsk) {
          // Sell Yes: matches against USDC bids at price >= our price
          matchableOrders = orders
            .filter((o) => o.side === Side.UsdcBid && o.priceLevel >= priceU8)
            .sort((a, b) => b.priceLevel - a.priceLevel); // best (highest) bid first
        } else if (sideU8 === Side.NoBackedBid) {
          // Buy No: matches against Yes asks
          matchableOrders = orders
            .filter((o) => o.side === Side.YesAsk && (100 - o.priceLevel) <= priceU8)
            .sort((a, b) => b.priceLevel - a.priceLevel);
        }

        // Take up to maxFills unique makers
        const seen = new Set<string>();
        for (const order of matchableOrders) {
          if (makerAccounts.length >= maxFills) break;
          const makerKey = order.owner.toBase58();
          if (seen.has(makerKey)) continue;
          seen.add(makerKey);

          // Determine which ATA the maker needs
          let makerAta: PublicKey;
          if (sideU8 === Side.YesAsk) {
            // Sell Yes fills USDC bids → maker needs Yes tokens
            makerAta = getAssociatedTokenAddressSync(yesMint, order.owner);
          } else {
            // Buy Yes / Buy No fills → maker gets USDC
            makerAta = getAssociatedTokenAddressSync(USDC_MINT, order.owner);
          }
          makerAccounts.push({ pubkey: makerAta, isSigner: false, isWritable: true });
        }
      }

      const placeOrderIx = await program.methods
        .placeOrder(sideU8, priceU8, new BN(quantityLamports!), orderTypeU8, maxFills)
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

      const sideLabel = side.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
      await sendTransaction(tx, { description: `Place ${sideLabel} Order` });
    } catch {
      // Error already handled by useTransaction toast
    } finally {
      setSubmitting(false);
    }
  }, [
    isValid,
    program,
    walletPublicKey,
    submitting,
    marketPubkey,
    side,
    orderType,
    effectivePrice,
    quantityLamports,
    sendTransaction,
    orderBookData,
  ]);

  const handleSubmit = useCallback(() => {
    if (isMainnet) {
      setShowConfirmModal(true);
    } else {
      handleSubmitDirect();
    }
  }, [isMainnet, handleSubmitDirect]);

  const handleConfirmMainnet = useCallback(() => {
    setShowConfirmModal(false);
    handleSubmitDirect();
  }, [handleSubmitDirect]);

  const isBuying = side === "buy-yes" || side === "buy-no";

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white/80">Place Order</h3>

      {/* Side selector */}
      <div className="grid grid-cols-2 gap-1 rounded-md border border-white/10 p-0.5 text-xs">
        {(["buy-yes", "sell-yes", "buy-no", "sell-no"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`rounded px-2 py-1.5 transition-colors ${
              side === s
                ? s.includes("yes")
                  ? "bg-yes/20 text-yes"
                  : "bg-no/20 text-no"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {s === "buy-yes" && "Buy Yes"}
            {s === "sell-yes" && "Sell Yes"}
            {s === "buy-no" && "Buy No"}
            {s === "sell-no" && "Sell No"}
          </button>
        ))}
      </div>

      {/* Order type toggle */}
      <div className="flex rounded-md border border-white/10 text-xs">
        <button
          onClick={() => setOrderType("limit")}
          className={`flex-1 px-3 py-1.5 transition-colors ${
            orderType === "limit"
              ? "bg-accent/20 text-accent"
              : "text-white/50 hover:text-white/80"
          }`}
        >
          Limit
        </button>
        <button
          onClick={() => setOrderType("market")}
          className={`flex-1 px-3 py-1.5 transition-colors ${
            orderType === "market"
              ? "bg-accent/20 text-accent"
              : "text-white/50 hover:text-white/80"
          }`}
        >
          Market
        </button>
      </div>

      {/* Price input (limit only) */}
      {orderType === "limit" && (
        <div>
          <label className="block text-xs text-white/50 mb-1">
            Price (1-99c)
          </label>
          <div className="relative">
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
              placeholder="50"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40">
              c
            </span>
          </div>
        </div>
      )}

      {/* Quantity input */}
      <div>
        <label className="block text-xs text-white/50 mb-1">
          Quantity (tokens)
        </label>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
          placeholder="1"
        />
      </div>

      {/* Cost estimate */}
      {estimatedCost !== null && (
        <div className="rounded-md bg-white/5 px-3 py-2 text-xs">
          <span className="text-white/50">
            {isBuying ? "Est. Cost" : "Est. Proceeds"}:{" "}
          </span>
          <span className="font-medium text-white">
            ${estimatedCost.toFixed(2)} USDC
          </span>
        </div>
      )}

      {/* Ticker / strike context */}
      <div className="text-[11px] text-white/40">
        {ticker} @ ${(strikePrice / 1_000_000).toFixed(2)} strike
      </div>

      {/* Market order liquidity warning */}
      {marketOrderWarning && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {marketOrderWarning}
        </div>
      )}

      {/* Position constraint warning */}
      {positionConflict && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {positionConflict}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!isValid || submitting || !!positionConflict || !!marketOrderWarning}
        className={`w-full rounded-md py-2.5 text-sm font-semibold transition-colors ${
          isBuying
            ? "bg-yes hover:bg-yes-dark disabled:bg-yes/30"
            : "bg-no hover:bg-no-dark disabled:bg-no/30"
        } text-white disabled:cursor-not-allowed`}
      >
        {submitting
          ? "Submitting..."
          : `${isBuying ? "Buy" : "Sell"} ${side.includes("yes") ? "Yes" : "No"}`}
      </button>

      {isMainnet && (
        <TradeConfirmationModal
          isOpen={showConfirmModal}
          onConfirm={handleConfirmMainnet}
          onCancel={() => setShowConfirmModal(false)}
          ticker={ticker}
          side={side.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          price={effectivePrice ?? 50}
          quantity={parseFloat(quantity) || 0}
          estimatedCost={estimatedCost ?? 0}
        />
      )}
    </div>
  );
}
