"use client";

/**
 * OrderTree — dual-column order book visualization for a single strike.
 *
 * Poses the binary question front and center, then shows Yes orders
 * descending left (99→1) and No orders ascending right (1→99).
 * Click a row → opens the Order Modal at that price.
 */

import { useMemo, useState, useCallback } from "react";
import { useOrderBook, type OrderBookData } from "@/hooks/useMarkets";
import { Side } from "@/lib/orderbook";
import { OrderModal, type OrderModalSide } from "./OrderModal";
import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeRow {
  yesPrice: number;
  noPrice: number;
  yesQty: number;
  yesOrders: number;
  noQty: number;
  noOrders: number;
}

interface OrderTreeProps {
  marketPubkey: PublicKey | null;
  altAddress?: PublicKey;
  ticker: string;
  strikePrice: number;
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
    const rowIdx = 99 - order.priceLevel;
    if (rowIdx < 0 || rowIdx >= 99) continue;
    const row = rows[rowIdx];
    const qty = Number(order.quantity) / USDC_LAMPORTS;

    if (order.side === Side.YesAsk) {
      row.yesQty += qty;
      row.yesOrders += 1;
    } else if (order.side === Side.UsdcBid) {
      row.noQty += qty;
      row.noOrders += 1;
    } else if (order.side === Side.NoBackedBid) {
      row.noQty += qty;
      row.noOrders += 1;
    }
  }

  return rows;
}

function formatQty(qty: number): string {
  if (qty >= 1000) return `${(qty / 1000).toFixed(1)}k`;
  return Math.floor(qty).toLocaleString();
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

  const visibleRows = useMemo(() => {
    if (showAllLevels) return allRows;
    return allRows.filter((r) => r.yesQty > 0 || r.noQty > 0);
  }, [allRows, showAllLevels]);

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
  const strikeDollars = (strikePrice / USDC_LAMPORTS).toFixed(0);

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-gradient-to-b from-white/[0.03] to-transparent">
      {/* Question header */}
      <div className="px-5 pt-5 pb-4 text-center border-b border-white/10">
        <p className="text-[11px] uppercase tracking-[0.2em] text-white/30 mb-1.5">
          Today&apos;s Question
        </p>
        <h2 className="text-lg font-bold text-white">
          Will <span className="text-accent">{ticker}</span> close above{" "}
          <span className="text-green-400">${strikeDollars}</span> today?
        </h2>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_56px_56px_1fr] border-b border-white/10 bg-white/[0.02]">
        <div className="px-4 py-2.5 text-right">
          <span className="text-sm font-bold text-green-400">YES</span>
          <span className="text-[10px] text-white/30 ml-1.5">depth</span>
        </div>
        <div className="flex items-center justify-center border-x border-white/5">
          <span className="text-[10px] text-white/25 font-medium">YES ¢</span>
        </div>
        <div className="flex items-center justify-center border-r border-white/5">
          <span className="text-[10px] text-white/25 font-medium">NO ¢</span>
        </div>
        <div className="px-4 py-2.5">
          <span className="text-sm font-bold text-red-400">NO</span>
          <span className="text-[10px] text-white/30 ml-1.5">depth</span>
        </div>
      </div>

      {/* Order rows */}
      <div className="max-h-[480px] overflow-y-auto">
        {visibleRows.length === 0 && !showAllLevels ? (
          <div className="px-6 py-10 text-center space-y-4">
            <div className="text-white/30 text-sm">
              No open orders on this strike yet.
            </div>
            <button
              onClick={() => setShowAllLevels(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-5 py-2.5 text-sm font-semibold text-accent hover:bg-accent/20 transition-colors"
            >
              No Orders Yet, Start One
            </button>
          </div>
        ) : (
          visibleRows.map((row) => {
            const yesIntensity = row.yesQty / maxQty;
            const noIntensity = row.noQty / maxQty;

            return (
              <div
                key={row.yesPrice}
                className="grid grid-cols-[1fr_56px_56px_1fr] border-b border-white/[0.04] last:border-b-0 group/row hover:bg-white/[0.02] transition-colors"
              >
                {/* YES side — click to trade */}
                <button
                  onClick={() => handleRowClick(row.yesQty > 0 ? "buy-yes" : "sell-yes", row.yesPrice)}
                  className="relative text-right pr-4 py-2 cursor-pointer group/yes"
                  title={row.yesQty > 0 ? `Buy Yes @ ${row.yesPrice}¢` : `Sell Yes @ ${row.yesPrice}¢`}
                >
                  {/* Volume bar */}
                  <div
                    className="absolute inset-y-0 right-0 bg-green-500/20 group-hover/yes:bg-green-500/30 transition-all rounded-l-sm"
                    style={{ width: `${Math.max(0, yesIntensity * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-end gap-2">
                    {row.yesOrders > 0 && (
                      <span className="text-[10px] text-white/25 tabular-nums">{row.yesOrders}×</span>
                    )}
                    {row.yesQty > 0 ? (
                      <span className="text-sm font-mono font-medium text-green-400/90 group-hover/yes:text-green-300 tabular-nums transition-colors">
                        {formatQty(row.yesQty)}
                      </span>
                    ) : (
                      <span className="text-sm text-white/10 group-hover/yes:text-green-400/40 transition-colors">
                        +
                      </span>
                    )}
                  </div>
                </button>

                {/* YES price cell */}
                <div className="flex items-center justify-center text-sm font-mono font-medium text-white/50 bg-white/[0.015] border-x border-white/[0.04] tabular-nums">
                  {row.yesPrice}
                </div>

                {/* NO price cell */}
                <div className="flex items-center justify-center text-sm font-mono font-medium text-white/50 bg-white/[0.015] border-r border-white/[0.04] tabular-nums">
                  {row.noPrice}
                </div>

                {/* NO side — click to trade */}
                <button
                  onClick={() => handleRowClick(row.noQty > 0 ? "buy-no" : "sell-no", row.yesPrice)}
                  className="relative text-left pl-4 py-2 cursor-pointer group/no"
                  title={row.noQty > 0 ? `Buy No @ ${row.noPrice}¢` : `Sell No @ ${row.noPrice}¢`}
                >
                  {/* Volume bar */}
                  <div
                    className="absolute inset-y-0 left-0 bg-red-500/20 group-hover/no:bg-red-500/30 transition-all rounded-r-sm"
                    style={{ width: `${Math.max(0, noIntensity * 100)}%` }}
                  />
                  <div className="relative flex items-center gap-2">
                    {row.noQty > 0 ? (
                      <span className="text-sm font-mono font-medium text-red-400/90 group-hover/no:text-red-300 tabular-nums transition-colors">
                        {formatQty(row.noQty)}
                      </span>
                    ) : (
                      <span className="text-sm text-white/10 group-hover/no:text-red-400/40 transition-colors">
                        +
                      </span>
                    )}
                    {row.noOrders > 0 && (
                      <span className="text-[10px] text-white/25 tabular-nums">×{row.noOrders}</span>
                    )}
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Expand / Collapse toggle */}
      {(hasAnyOrders || showAllLevels) && (
        <div className="border-t border-white/10">
          <button
            onClick={() => setShowAllLevels(!showAllLevels)}
            className="w-full text-center text-xs text-white/30 hover:text-white/50 py-2.5 transition-colors"
          >
            {showAllLevels ? "Show active levels only" : `Show all 99 levels`}
          </button>
        </div>
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
