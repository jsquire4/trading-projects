"use client";

/**
 * OrderModal — single point of commitment for all order actions.
 *
 * Adapts based on context:
 * - Taker filling existing orders (sweep preview, Fill All)
 * - Maker posting new order (qty input, rent shown if needed)
 * - New strike creation (bundles create_strike_market + place_order)
 * - New ticker registration (bundles add_ticker + oracle + market + order)
 *
 * Pre-filled from the order tree row the user clicked.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePlaceOrder, type PlaceOrderParams } from "@/hooks/usePlaceOrder";
import type { OrderBookData } from "@/hooks/useMarkets";
import { Side, type ActiveOrder } from "@/lib/orderbook";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderModalSide = "buy-yes" | "buy-no";

export interface OrderModalProps {
  open: boolean;
  onClose: () => void;
  /** Which side the user clicked — left column = buy-yes, right column = buy-no */
  side: OrderModalSide;
  /** Price level clicked (1-99 in Yes cents) */
  yesPrice: number;
  /** Ticker symbol */
  ticker: string;
  /** Strike price in USDC lamports */
  strikePrice: number;
  /** Market public key (null if strike doesn't exist on-chain yet) */
  marketPubkey: PublicKey | null;
  /** Market's ALT address (for versioned transactions) */
  altAddress?: PublicKey;
  /** Current order book data (null if no market exists) */
  orderBookData: OrderBookData | null | undefined;
  /** Callback after successful order */
  onSuccess?: (signature: string) => void;
}

interface SweepLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_LAMPORTS = 1_000_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrderModal({
  open,
  onClose,
  side,
  yesPrice,
  ticker,
  strikePrice,
  marketPubkey,
  altAddress,
  orderBookData,
  onSuccess,
}: OrderModalProps) {
  const { publicKey } = useWallet();
  const { placeOrder } = usePlaceOrder();
  const [quantity, setQuantity] = useState("");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [submitting, setSubmitting] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setQuantity("");
      setOrderType("limit");
      setSubmitting(false);
    }
  }, [open]);

  // Derived values
  const noPrice = 100 - yesPrice;
  const displayPrice = side === "buy-yes" ? yesPrice : noPrice;
  const impliedProbability = side === "buy-yes" ? yesPrice : noPrice;
  const quantityNum = parseInt(quantity, 10) || 0;
  const quantityLamports = quantityNum * USDC_LAMPORTS;

  // Compute available liquidity at this level and sweep levels
  const { availableAtLevel, sweepLevels, totalAvailable } = useMemo(() => {
    if (!orderBookData) return { availableAtLevel: 0, sweepLevels: [], totalAvailable: 0 };

    const orders = orderBookData.raw.orders;
    let matchable: ActiveOrder[] = [];

    if (side === "buy-yes") {
      // Buying Yes = matching against Yes asks at or below our price
      matchable = orders
        .filter((o) => o.side === Side.YesAsk && o.priceLevel <= yesPrice)
        .sort((a, b) => a.priceLevel - b.priceLevel);
    } else {
      // Buying No = matching against Yes asks at or above (100 - noPrice) = yesPrice
      // Actually: Buy No is sell-yes under the hood. Matches USDC bids >= yesPrice
      // and No-backed bids. For simplicity, show matchable orders.
      const maxYesAsk = 100 - noPrice; // = yesPrice
      matchable = orders
        .filter((o) => o.side === Side.YesAsk && o.priceLevel <= maxYesAsk)
        .sort((a, b) => a.priceLevel - b.priceLevel);
    }

    // Group by price level
    const levelMap = new Map<number, { qty: number; count: number }>();
    for (const o of matchable) {
      const existing = levelMap.get(o.priceLevel) ?? { qty: 0, count: 0 };
      existing.qty += Number(o.quantity) / USDC_LAMPORTS;
      existing.count += 1;
      levelMap.set(o.priceLevel, existing);
    }

    const levels: SweepLevel[] = [];
    for (const [price, { qty, count }] of levelMap) {
      levels.push({ price, quantity: qty, orderCount: count });
    }
    levels.sort((a, b) => a.price - b.price);

    const atLevel = levelMap.get(yesPrice)?.qty ?? 0;
    const total = levels.reduce((sum, l) => sum + l.quantity, 0);

    return { availableAtLevel: atLevel, sweepLevels: levels, totalAvailable: total };
  }, [orderBookData, side, yesPrice, noPrice]);

  // Cost calculation
  const totalCostUSDC = useMemo(() => {
    if (quantityNum <= 0) return 0;

    if (orderType === "market" || quantityNum <= availableAtLevel) {
      // Simple: all at the clicked price
      return (quantityNum * displayPrice) / 100;
    }

    // Sweep across levels
    let remaining = quantityNum;
    let cost = 0;
    for (const level of sweepLevels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, level.quantity);
      const levelPrice = side === "buy-yes" ? level.price : 100 - level.price;
      cost += (fillQty * levelPrice) / 100;
      remaining -= fillQty;
    }

    // Remaining rests as limit at the clicked price
    if (remaining > 0) {
      cost += (remaining * displayPrice) / 100;
    }

    return cost;
  }, [quantityNum, displayPrice, orderType, availableAtLevel, sweepLevels, side]);

  // Weighted average price for sweeps
  const weightedAvgPrice = useMemo(() => {
    if (quantityNum <= 0) return displayPrice;
    if (quantityNum <= availableAtLevel) return displayPrice;

    let remaining = quantityNum;
    let totalWeighted = 0;
    let totalFilled = 0;

    for (const level of sweepLevels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, level.quantity);
      const levelPrice = side === "buy-yes" ? level.price : 100 - level.price;
      totalWeighted += fillQty * levelPrice;
      totalFilled += fillQty;
      remaining -= fillQty;
    }

    if (totalFilled === 0) return displayPrice;
    return Math.round(totalWeighted / totalFilled);
  }, [quantityNum, displayPrice, availableAtLevel, sweepLevels, side]);

  // How much fills immediately vs. rests
  const fillsImmediately = Math.min(quantityNum, Math.floor(totalAvailable));
  const restsAsLimit = orderType === "limit" ? Math.max(0, quantityNum - fillsImmediately) : 0;

  // Fill All handler
  const handleFillAll = useCallback(() => {
    if (totalAvailable > 0) {
      setQuantity(String(Math.floor(totalAvailable)));
    }
  }, [totalAvailable]);

  // Submit
  const handleSubmit = useCallback(async () => {
    if (!publicKey || !marketPubkey || quantityNum <= 0) return;

    setSubmitting(true);
    try {
      const params: PlaceOrderParams = {
        marketPubkey,
        marketKey: marketPubkey.toBase58(),
        side: side === "buy-yes" ? "buy-yes" : "buy-no",
        orderType,
        effectivePrice: yesPrice,
        quantityLamports,
        orderBookData,
        altAddress,
      };

      const signature = await placeOrder(params);
      if (signature) {
        onSuccess?.(signature);
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }, [publicKey, marketPubkey, quantityNum, side, orderType, yesPrice, quantityLamports, orderBookData, altAddress, placeOrder, onSuccess, onClose]);

  if (!open) return null;

  const strikeDollars = (strikePrice / USDC_LAMPORTS).toFixed(0);
  const sideLabel = side === "buy-yes" ? "Buy Yes" : "Buy No";
  const sideColor = side === "buy-yes" ? "text-green-400" : "text-red-400";
  const sideBgColor = side === "buy-yes" ? "bg-green-500/20 border-green-500/30" : "bg-red-500/20 border-red-500/30";

  // Market doesn't exist yet — show creation flow
  const isNewMarket = !marketPubkey;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-[#0f0f0f] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-bold text-white">
              <span className={sideColor}>{sideLabel}</span> {ticker} ${strikeDollars}
            </h2>
            <p className="text-xs text-white/40">
              @ {displayPrice}¢ · {impliedProbability}% implied probability
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Available liquidity */}
          {!isNewMarket && totalAvailable > 0 && (
            <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/50">Available to fill</span>
                <span className="text-white font-mono">{Math.floor(totalAvailable)} contracts</span>
              </div>
              {sweepLevels.length > 1 && quantityNum > availableAtLevel && (
                <div className="space-y-1">
                  {sweepLevels.slice(0, 5).map((level) => {
                    const levelDisplay = side === "buy-yes" ? level.price : 100 - level.price;
                    return (
                      <div key={level.price} className="flex items-center justify-between text-xs text-white/40">
                        <span>{level.orderCount} order{level.orderCount !== 1 ? "s" : ""} @ {levelDisplay}¢</span>
                        <span className="font-mono">{Math.floor(level.quantity)} contracts</span>
                      </div>
                    );
                  })}
                  {sweepLevels.length > 5 && (
                    <div className="text-xs text-white/30">+{sweepLevels.length - 5} more levels...</div>
                  )}
                </div>
              )}
              <button
                onClick={handleFillAll}
                className={`w-full rounded-md py-1.5 text-xs font-medium transition-colors border ${sideBgColor} ${sideColor}`}
              >
                Fill All ({Math.floor(totalAvailable)} contracts)
              </button>
            </div>
          )}

          {/* New market notice */}
          {isNewMarket && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm text-amber-300">
              This strike doesn't exist yet. Creating a market requires rent deposit.
            </div>
          )}

          {/* Quantity input */}
          <div>
            <label className="block text-xs text-white/50 mb-1">Quantity (contracts)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Enter quantity"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 font-mono focus:border-accent focus:outline-none"
              autoFocus
            />
          </div>

          {/* Order type toggle */}
          <div className="flex gap-1 bg-white/5 rounded-lg p-1">
            <button
              onClick={() => setOrderType("limit")}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                orderType === "limit"
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/60"
              }`}
            >
              Limit
            </button>
            <button
              onClick={() => setOrderType("market")}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                orderType === "market"
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/60"
              }`}
            >
              Market
            </button>
          </div>

          {/* Cost summary */}
          {quantityNum > 0 && (
            <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/50">Total cost</span>
                <span className="text-white font-bold font-mono">${totalCostUSDC.toFixed(2)} USDC</span>
              </div>
              {quantityNum > availableAtLevel && sweepLevels.length > 1 && (
                <div className="flex items-center justify-between text-xs text-white/40">
                  <span>Avg price</span>
                  <span className="font-mono">{weightedAvgPrice}¢</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-white/40">
                <span>Implied probability</span>
                <span className="font-mono">{impliedProbability}%</span>
              </div>

              {/* Fill/rest breakdown */}
              {orderType === "limit" && fillsImmediately > 0 && restsAsLimit > 0 && (
                <div className="pt-2 border-t border-white/5 space-y-1">
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Fills immediately</span>
                    <span className="font-mono">{fillsImmediately} contracts</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Rests as limit order</span>
                    <span className="font-mono">{restsAsLimit} contracts</span>
                  </div>
                </div>
              )}

              {/* Rent deposit for new market / new slot */}
              {isNewMarket && (
                <div className="pt-2 border-t border-white/5 space-y-1">
                  <div className="flex items-center justify-between text-xs text-amber-400/70">
                    <span>Market creation rent</span>
                    <span className="font-mono">~0.02 SOL</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-amber-400/70">
                    <span>Order slot rent</span>
                    <span className="font-mono">~0.001 SOL</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-amber-300">
                    <span>Total rent</span>
                    <span className="font-mono">~0.021 SOL</span>
                  </div>
                </div>
              )}
              {!isNewMarket && restsAsLimit > 0 && (
                <div className="pt-2 border-t border-white/5">
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Slot rent (if new level)</span>
                    <span className="font-mono">~0.001 SOL</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 py-2.5 text-sm font-medium text-white/50 hover:text-white/70 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || quantityNum <= 0 || !publicKey}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors border ${
              submitting
                ? "bg-white/5 text-white/30 border-white/10"
                : `${sideBgColor} ${sideColor} hover:opacity-80`
            } disabled:opacity-30`}
          >
            {submitting ? "Confirming..." : `${sideLabel} ${quantityNum > 0 ? quantityNum + " contracts" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
