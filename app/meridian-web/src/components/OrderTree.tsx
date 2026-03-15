"use client";

/**
 * OrderTree — dual-column order book visualization for a single strike.
 *
 * Shows Yes prices descending left (99→1), No prices ascending right (1→99).
 * Collapsed to levels with open interest by default. Each row shows:
 * - # orders, remaining qty, dynamic color intensity by volume.
 * Click a row → calls onRowClick with side + price for the Order Modal.
 */

import { useMemo, useState, useCallback } from "react";
import { useOrderBook, type OrderBookData } from "@/hooks/useMarkets";
import { Side, type ActiveOrder } from "@/lib/orderbook";
import { OrderModal, type OrderModalSide } from "./OrderModal";
import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeRow {
  /** Yes price (1-99) */
  yesPrice: number;
  /** No price (complement: 100 - yesPrice) */
  noPrice: number;
  /** Yes-side: total remaining quantity (token units, not lamports) */
  yesQty: number;
  /** Yes-side: number of resting orders */
  yesOrders: number;
  /** No-side: total remaining quantity (USDC bids that back No) */
  noQty: number;
  /** No-side: number of resting orders */
  noOrders: number;
}

interface OrderTreeProps {
  /** Market public key (null if strike doesn't exist on-chain) */
  marketPubkey: PublicKey | null;
  /** Market's ALT address */
  altAddress?: PublicKey;
  /** Ticker symbol */
  ticker: string;
  /** Strike price in USDC lamports */
  strikePrice: number;
  /** Market key string for query cache */
  marketKey: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_LAMPORTS = 1_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRows(orderBookData: OrderBookData | null | undefined): TreeRow[] {
  const rows: TreeRow[] = [];

  for (let yesPrice = 99; yesPrice >= 1; yesPrice--) {
    rows.push({
      yesPrice,
      noPrice: 100 - yesPrice,
      yesQty: 0,
      yesOrders: 0,
      noQty: 0,
      noOrders: 0,
    });
  }

  if (!orderBookData) return rows;

  const orders = orderBookData.raw.orders;

  for (const order of orders) {
    const rowIdx = 99 - order.priceLevel; // yesPrice 99 is index 0
    if (rowIdx < 0 || rowIdx >= 99) continue;
    const row = rows[rowIdx];

    const qty = Number(order.quantity) / USDC_LAMPORTS;

    if (order.side === Side.YesAsk) {
      // Yes asks sit at their price level
      row.yesQty += qty;
      row.yesOrders += 1;
    } else if (order.side === Side.UsdcBid) {
      // USDC bids: someone wants to BUY Yes at this price
      // From the No perspective, this is liquidity at (100 - price) on the No side
      row.noQty += qty;
      row.noOrders += 1;
    } else if (order.side === Side.NoBackedBid) {
      // No-backed bids: someone selling No at this price level
      // This appears on the No side
      row.noQty += qty;
      row.noOrders += 1;
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrderTree({
  marketPubkey,
  altAddress,
  ticker,
  strikePrice,
  marketKey,
}: OrderTreeProps) {
  const { data: orderBookData } = useOrderBook(marketKey);
  const [showAllLevels, setShowAllLevels] = useState(false);
  const [modalState, setModalState] = useState<{
    open: boolean;
    side: OrderModalSide;
    yesPrice: number;
  }>({ open: false, side: "buy-yes", yesPrice: 50 });

  const allRows = useMemo(() => buildRows(orderBookData), [orderBookData]);

  // Filter to rows with open interest (unless show all)
  const visibleRows = useMemo(() => {
    if (showAllLevels) return allRows;
    return allRows.filter((r) => r.yesQty > 0 || r.noQty > 0 || r.yesOrders > 0 || r.noOrders > 0);
  }, [allRows, showAllLevels]);

  // Max qty for color scaling
  const maxQty = useMemo(() => {
    return Math.max(1, ...allRows.map((r) => Math.max(r.yesQty, r.noQty)));
  }, [allRows]);

  const handleRowClick = useCallback((side: OrderModalSide, yesPrice: number) => {
    setModalState({ open: true, side, yesPrice });
  }, []);

  const handleModalClose = useCallback(() => {
    setModalState((prev) => ({ ...prev, open: false }));
  }, []);

  const hasAnyOrders = allRows.some((r) => r.yesQty > 0 || r.noQty > 0);

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="grid grid-cols-[1fr_60px_60px_1fr] gap-0 text-xs text-white/40 px-2">
        <div className="text-right pr-2">Buy Yes</div>
        <div className="text-center">Yes ¢</div>
        <div className="text-center">No ¢</div>
        <div className="text-left pl-2">Buy No</div>
      </div>

      {/* Rows */}
      <div className="rounded-lg border border-white/10 overflow-hidden">
        {visibleRows.length === 0 ? (
          <div className="px-6 py-8 text-center text-white/30 text-sm">
            No open orders. Click "Show all levels" to post at any price.
          </div>
        ) : (
          visibleRows.map((row) => {
            const yesIntensity = row.yesQty / maxQty;
            const noIntensity = row.noQty / maxQty;

            return (
              <div
                key={row.yesPrice}
                className="grid grid-cols-[1fr_60px_60px_1fr] gap-0 border-b border-white/5 last:border-b-0"
              >
                {/* Yes side — clickable */}
                <button
                  onClick={() => handleRowClick("buy-yes", row.yesPrice)}
                  className="relative text-right pr-3 py-1.5 hover:bg-green-500/10 transition-colors group"
                >
                  {/* Volume bar */}
                  <div
                    className="absolute inset-y-0 right-0 bg-green-500/15 transition-all"
                    style={{ width: `${Math.max(0, yesIntensity * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-end gap-2">
                    {row.yesOrders > 0 && (
                      <span className="text-[10px] text-white/30">{row.yesOrders}×</span>
                    )}
                    {row.yesQty > 0 && (
                      <span className="text-xs font-mono text-green-400/80 group-hover:text-green-400">
                        {Math.floor(row.yesQty)}
                      </span>
                    )}
                  </div>
                </button>

                {/* Yes price */}
                <div className="flex items-center justify-center text-xs font-mono text-white/60 bg-white/[0.02]">
                  {row.yesPrice}
                </div>

                {/* No price */}
                <div className="flex items-center justify-center text-xs font-mono text-white/60 bg-white/[0.02]">
                  {row.noPrice}
                </div>

                {/* No side — clickable */}
                <button
                  onClick={() => handleRowClick("buy-no", row.yesPrice)}
                  className="relative text-left pl-3 py-1.5 hover:bg-red-500/10 transition-colors group"
                >
                  {/* Volume bar */}
                  <div
                    className="absolute inset-y-0 left-0 bg-red-500/15 transition-all"
                    style={{ width: `${Math.max(0, noIntensity * 100)}%` }}
                  />
                  <div className="relative flex items-center gap-2">
                    {row.noQty > 0 && (
                      <span className="text-xs font-mono text-red-400/80 group-hover:text-red-400">
                        {Math.floor(row.noQty)}
                      </span>
                    )}
                    {row.noOrders > 0 && (
                      <span className="text-[10px] text-white/30">×{row.noOrders}</span>
                    )}
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Expand/collapse */}
      {!showAllLevels ? (
        <button
          onClick={() => setShowAllLevels(true)}
          className="w-full text-center text-xs text-white/40 hover:text-white/60 py-2 transition-colors"
        >
          Show all 99 levels
        </button>
      ) : (
        <button
          onClick={() => setShowAllLevels(false)}
          className="w-full text-center text-xs text-white/40 hover:text-white/60 py-2 transition-colors"
        >
          Collapse to active levels
        </button>
      )}

      {/* Order Modal */}
      <OrderModal
        open={modalState.open}
        onClose={handleModalClose}
        side={modalState.side}
        yesPrice={modalState.yesPrice}
        ticker={ticker}
        strikePrice={strikePrice}
        marketPubkey={marketPubkey}
        altAddress={altAddress}
        orderBookData={orderBookData}
      />
    </div>
  );
}
