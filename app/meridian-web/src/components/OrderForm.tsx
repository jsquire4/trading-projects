// DEPRECATED: OrderForm has been replaced by OrderModal. This file is no longer used in production.
"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";

import { useNetwork } from "@/hooks/useNetwork";
import { usePositions } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { usePlaceOrder } from "@/hooks/usePlaceOrder";
import { TradeConfirmationModal } from "@/components/TradeConfirmationModal";

// Side encoding (on-chain has only 3 sides):
//   0 = Buy Yes (bid on yes tokens, spends USDC)
//   1 = Sell Yes (ask yes tokens, receives USDC)
//   2 = Sell No (no-backed bid — escrows No tokens, receives USDC via merge/burn)
// "Buy No" is a composite: mint pair + sell Yes on the order book.
// Order type: 0 = Market, 1 = Limit
type OrderSide = "buy-yes" | "sell-yes" | "sell-no" | "buy-no";

interface OrderFormProps {
  marketKey: string;
  ticker: string;
  strikePrice: number;
  /** Externally-set price (e.g. from OrderBook click) */
  initialPrice?: number | null;
  /** Callback after successful transaction */
  onTransactionSuccess?: (signature: string) => void;
}

const LAMPORTS_PER_TOKEN = 1_000_000;

export function OrderForm({ marketKey, ticker, strikePrice, initialPrice, onTransactionSuccess }: OrderFormProps) {
  const [side, setSide] = useState<OrderSide>("buy-yes");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState<string>("50");
  const [dollarAmount, setDollarAmount] = useState<string>("10");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Update price when externally set (e.g. OrderBook click)
  useEffect(() => {
    if (initialPrice != null && initialPrice >= 1 && initialPrice <= 99) {
      setPrice(String(initialPrice));
      setOrderType("limit");
    }
  }, [initialPrice]);

  const { publicKey: walletPublicKey } = useWallet();
  const { isMainnet } = useNetwork();
  const { data: positions = [] } = usePositions();
  const { placeOrder } = usePlaceOrder();

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
    if ((side === "sell-no") && currentPosition.yesBal > BigInt(0) && currentPosition.noBal === BigInt(0)) {
      return "You hold Yes tokens but no No tokens. Sell your Yes position first, or use Buy No to switch sides.";
    }
    return null;
  }, [side, currentPosition]);

  // Check if the order book has liquidity on the side the user needs
  const marketOrderWarning = useMemo((): string | null => {
    if (orderType !== "market") return null;
    if (!orderBookData) return null;
    const yesView = orderBookData.yesView;
    // Buy Yes = needs asks on Yes book. Sell Yes = needs bids on Yes book.
    // Sell No = matches against Yes asks (merge/burn).
    // Buy No = sell Yes side, needs bids on Yes book.
    if (side === "buy-yes" && (yesView.bestAsk === null)) {
      return "No sell orders on the book — market buy can't fill. Use a limit order instead.";
    }
    if ((side === "sell-yes" || side === "buy-no") && (yesView.bestBid === null)) {
      return "No buy orders on the book — market order can't fill. Use a limit order instead.";
    }
    // Sell No matches against Yes asks (via merge/burn).
    // Check if there are Yes asks available (shown as bids in the No view after inversion).
    if (side === "sell-no") {
      if (yesView.bestAsk === null) {
        return "No Yes asks on the book — sell No can't fill. Use a limit order instead.";
      }
    }
    return null;
  }, [orderType, orderBookData, side]);

  const effectivePrice = useMemo(() => {
    if (orderType === "market") return null;
    const p = parseInt(price, 10);
    if (isNaN(p) || p < 1 || p > 99) return null;
    return p;
  }, [price, orderType]);

  // For market orders, use best ask (buys) or best bid (sells) from the order book
  const marketPrice = useMemo((): number | null => {
    if (orderType !== "market" || !orderBookData) return null;
    const yesView = orderBookData.yesView;
    const noView = orderBookData.noView;
    if (side === "buy-yes") return yesView.bestAsk;
    if (side === "sell-yes") return yesView.bestBid;
    // Buy No: we sell Yes, so price is from Yes bids. But user sees No price = 100 - yesBid.
    if (side === "buy-no") {
      const yesBid = yesView.bestBid;
      return yesBid !== null ? 100 - yesBid : null;
    }
    // Sell No: best price is the highest Yes ask complement available
    if (side === "sell-no") return noView.bestBid;
    return null;
  }, [orderType, orderBookData, side]);

  // Dollar-denominated input: compute quantity from dollar amount and price
  const quantityLamports = useMemo(() => {
    const dollars = parseFloat(dollarAmount);
    if (isNaN(dollars) || dollars <= 0) return null;

    // For all sides, the user's entered price represents what they pay per contract.
    // cost per contract = price / 100 (price is in cents)
    const priceForCalc = effectivePrice ?? marketPrice;
    if (!priceForCalc) return null;

    const costPerContract = priceForCalc / 100;
    if (costPerContract <= 0) return null;

    const qty = dollars / costPerContract;
    const lamports = Math.floor(qty * LAMPORTS_PER_TOKEN);
    return lamports >= LAMPORTS_PER_TOKEN ? lamports : null;
  }, [dollarAmount, effectivePrice, marketPrice]);

  // Derived quantity for display
  const derivedQuantity = useMemo(() => {
    if (!quantityLamports) return null;
    return quantityLamports / LAMPORTS_PER_TOKEN;
  }, [quantityLamports]);

  const displayPrice = effectivePrice ?? marketPrice;

  const estimatedCost = useMemo(() => {
    if (!quantityLamports || !displayPrice) return null;
    return (displayPrice / 100) * (quantityLamports / LAMPORTS_PER_TOKEN);
  }, [quantityLamports, displayPrice]);

  // Payout estimate: for buys, payout is $1 per contract if condition is met
  const estimatedPayout = useMemo(() => {
    if (!quantityLamports) return null;
    return quantityLamports / LAMPORTS_PER_TOKEN;
  }, [quantityLamports]);

  const isValid = useMemo(() => {
    if (!quantityLamports || quantityLamports < LAMPORTS_PER_TOKEN) return false;
    if (orderType === "limit" && !effectivePrice) return false;
    if (!walletPublicKey) return false;
    return true;
  }, [quantityLamports, effectivePrice, orderType, walletPublicKey]);

  const handleSubmitDirect = useCallback(async () => {
    if (!isValid || !walletPublicKey || submitting) return;
    setSubmitting(true);

    try {
      const signature = await placeOrder({
        marketPubkey,
        marketKey,
        side,
        orderType,
        effectivePrice,
        quantityLamports: quantityLamports!,
        orderBookData,
      });
      if (signature) {
        onTransactionSuccess?.(signature);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Order failed";
      const { toast } = await import("sonner");
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [
    isValid,
    walletPublicKey,
    submitting,
    placeOrder,
    marketPubkey,
    marketKey,
    side,
    orderType,
    effectivePrice,
    quantityLamports,
    orderBookData,
    onTransactionSuccess,
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
      <div className="grid grid-cols-4 gap-1 rounded-md border border-white/10 p-0.5 text-xs">
        {(["buy-yes", "buy-no", "sell-yes", "sell-no"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`rounded px-2 py-1.5 transition-colors ${
              side === s
                ? s === "buy-yes" || s === "buy-no"
                  ? s === "buy-yes" ? "bg-yes/20 text-yes" : "bg-no/20 text-no"
                  : "bg-no/20 text-no"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {s === "buy-yes" && "Buy Yes"}
            {s === "buy-no" && "Buy No"}
            {s === "sell-yes" && "Sell Yes"}
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

      {/* Dollar amount input */}
      <div>
        <label className="block text-xs text-white/50 mb-1">
          Amount ($)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/40">
            $
          </span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={dollarAmount}
            onChange={(e) => setDollarAmount(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-white/5 pl-7 pr-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            placeholder="10.00"
          />
        </div>
        {derivedQuantity !== null && (
          <p className="text-[10px] text-white/40 mt-1">
            ≈ {derivedQuantity.toFixed(derivedQuantity % 1 === 0 ? 0 : 2)} contracts
          </p>
        )}
      </div>

      {/* Cost / payout estimate */}
      {estimatedCost !== null && (
        <div className="rounded-md bg-white/5 px-3 py-2 text-xs space-y-1">
          <div>
            <span className="text-white/50">
              {isBuying ? "Cost" : "Est. Proceeds"}:{" "}
            </span>
            <span className="font-medium text-white">
              ${estimatedCost.toFixed(2)}
            </span>
          </div>
          {isBuying && estimatedPayout !== null && (
            <div>
              <span className="text-white/50">Payout:{" "}</span>
              <span className="font-medium text-white">
                ${estimatedPayout.toFixed(2)} if {side === "buy-yes" ? "Yes" : "No"} wins
              </span>
            </div>
          )}
        </div>
      )}

      {/* Rent disclosure for limit orders */}
      {orderType === "limit" && (
        <div className="text-[10px] text-white/20">
          ~0.002 SOL rent for new token accounts (one-time per market)
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
            ? side === "buy-yes"
              ? "bg-yes hover:bg-yes-dark disabled:bg-yes/30"
              : "bg-no hover:bg-no-dark disabled:bg-no/30"
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
          price={displayPrice ?? 50}
          quantity={derivedQuantity ?? 0}
          estimatedCost={estimatedCost ?? 0}
        />
      )}
    </div>
  );
}
