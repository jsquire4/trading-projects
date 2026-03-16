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
import { usePositions } from "@/hooks/usePositions";
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
  /** Optional content rendered right-aligned in the header (e.g. BinaryGreeks) */
  headerRight?: React.ReactNode;
  /** Called when a new market is created via the OrderModal (passes market pubkey base58) */
  onMarketCreated?: (marketKey: string) => void;
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
  headerRight,
  onMarketCreated,
}: OrderTreeProps) {
  const { data: orderBookData } = useOrderBook(marketKey);
  const { data: positions = [] } = usePositions();
  const [showAllLevels, setShowAllLevels] = useState(false);
  const [modalState, setModalState] = useState<{
    open: boolean;
    side: OrderModalSide;
    yesPrice: number;
  }>({ open: false, side: "buy-yes", yesPrice: 50 });

  // User's position on this market — determines smart modal defaults
  const userPosition = useMemo(() => {
    if (!marketPubkey) return null;
    const key = marketPubkey.toBase58();
    return positions.find((p) => p.market.publicKey.toBase58() === key) ?? null;
  }, [positions, marketPubkey]);
  const holdsYes = userPosition ? userPosition.yesBal > BigInt(0) : false;
  const holdsNo = userPosition ? userPosition.noBal > BigInt(0) : false;

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
    <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.03] to-transparent">
      {/* Market question header — question left, greeks right */}
      <div className="px-5 pt-5 pb-4 border-b border-white/10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">
            Will <span className="bg-gradient-to-r from-green-400 via-blue-400 to-purple-400 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(96,165,250,0.3)]">{ticker}</span> close above{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-green-300 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]">${strikeDollars}</span>?
          </h2>
          <p className="text-sm text-white/40 mt-1">$1 payout per winning contract</p>
        </div>
        {headerRight && (
          <div className="shrink-0">{headerRight}</div>
        )}
      </div>

      {/* Empty state — no table, just the CTA */}
      {!hasAnyOrders && !showAllLevels ? (
        <div className="px-6 py-10 flex items-center justify-center">
          <button
            onClick={() => setShowAllLevels(true)}
            className="group/cta relative overflow-hidden inline-flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-6 py-3 text-sm font-semibold text-accent hover:bg-accent/20 hover:scale-105 transition-all shadow-[0_0_20px_rgba(59,130,246,0.1)]"
          >
            <div className="absolute inset-0 -translate-x-full group-hover/cta:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
            <span className="relative">No Orders Yet, Start One</span>
          </button>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_64px_64px_1fr] border-b border-white/10 bg-white/[0.02]">
            <div className="px-4 py-3 text-right">
              <span className="text-base font-bold text-green-400">YES</span>
              <span className="text-xs text-white/30 ml-2">depth</span>
            </div>
            <div className="flex items-center justify-center border-x border-white/5">
              <span className="text-xs text-white/30 font-medium">YES ¢</span>
            </div>
            <div className="flex items-center justify-center border-r border-white/5">
              <span className="text-xs text-white/30 font-medium">NO ¢</span>
            </div>
            <div className="px-4 py-3">
              <span className="text-base font-bold text-red-400">NO</span>
              <span className="text-xs text-white/30 ml-2">depth</span>
            </div>
          </div>

          {/* Order rows */}
          <div className="max-h-[480px] overflow-y-auto">
            {visibleRows.length === 0 && !showAllLevels ? (
              <div className="px-6 py-10 text-center space-y-4">
                <div className="text-white/30 text-sm">No open orders on this strike yet.</div>
                <button
                  onClick={() => setShowAllLevels(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-5 py-2.5 text-sm font-semibold text-accent hover:bg-accent/20 transition-colors"
                >
                  Be the first — place an order
                </button>
              </div>
            ) : (
          visibleRows.map((row) => {
            const yesIntensity = row.yesQty / maxQty;
            const noIntensity = row.noQty / maxQty;

            return (
              <div
                key={row.yesPrice}
                className="grid grid-cols-[1fr_64px_64px_1fr] border-b border-white/[0.04] last:border-b-0 group/row hover:bg-white/[0.02] transition-colors"
              >
                {/* YES side — click to trade */}
                <button
                  onClick={() => handleRowClick(holdsYes ? "sell-yes" : "buy-yes", row.yesPrice)}
                  className="relative text-right pr-4 py-2 cursor-pointer group/yes"
                  title={row.yesQty > 0 ? `Buy Yes @ ${row.yesPrice}¢` : `Sell Yes @ ${row.yesPrice}¢`}
                >
                  {/* Volume bar — pulses when high volume */}
                  <div
                    className={`absolute inset-y-0 right-0 group-hover/yes:bg-green-500/30 transition-all rounded-l-sm ${
                      yesIntensity > 0.6
                        ? "bg-green-500/30 animate-pulse"
                        : yesIntensity > 0.3
                        ? "bg-green-500/25"
                        : "bg-green-500/15"
                    }`}
                    style={{ width: `${Math.max(0, yesIntensity * 100)}%` }}
                  />
                  {/* Glow effect for high volume */}
                  {yesIntensity > 0.5 && (
                    <div
                      className="absolute inset-y-0 right-0 bg-gradient-to-l from-green-400/10 to-transparent animate-pulse pointer-events-none"
                      style={{ width: `${Math.max(0, yesIntensity * 60)}%` }}
                    />
                  )}
                  <div className="relative flex items-center justify-end gap-2">
                    {row.yesOrders > 0 && (
                      <span className="text-xs text-white/30 tabular-nums">{row.yesOrders}×</span>
                    )}
                    {row.yesQty > 0 ? (
                      <span className="text-base font-mono font-semibold text-green-400 group-hover/yes:text-green-300 tabular-nums transition-colors">
                        {formatQty(row.yesQty)}
                      </span>
                    ) : (
                      <span className="text-sm text-white/10 group-hover/yes:text-green-400/40 transition-colors">
                        +
                      </span>
                    )}
                  </div>
                </button>

                {/* YES price cell — clickable */}
                <button
                  onClick={() => handleRowClick(holdsYes ? "sell-yes" : "buy-yes", row.yesPrice)}
                  className="flex items-center justify-center text-base font-mono font-semibold tabular-nums border-x border-white/[0.04] bg-white/[0.015] text-white/60 hover:bg-green-500/20 hover:text-green-300 hover:scale-105 transition-all duration-150 cursor-pointer"
                >
                  {row.yesPrice}
                </button>

                {/* NO price cell — clickable */}
                <button
                  onClick={() => handleRowClick(holdsNo ? "sell-no" : "buy-no", row.yesPrice)}
                  className="flex items-center justify-center text-base font-mono font-semibold tabular-nums border-r border-white/[0.04] bg-white/[0.015] text-white/60 hover:bg-red-500/20 hover:text-red-300 hover:scale-105 transition-all duration-150 cursor-pointer"
                >
                  {row.noPrice}
                </button>

                {/* NO side — click to trade */}
                <button
                  onClick={() => handleRowClick(holdsNo ? "sell-no" : "buy-no", row.yesPrice)}
                  className="relative text-left pl-4 py-2 cursor-pointer group/no"
                  title={row.noQty > 0 ? `Buy No @ ${row.noPrice}¢` : `Sell No @ ${row.noPrice}¢`}
                >
                  {/* Volume bar — pulses when high volume */}
                  <div
                    className={`absolute inset-y-0 left-0 group-hover/no:bg-red-500/30 transition-all rounded-r-sm ${
                      noIntensity > 0.6
                        ? "bg-red-500/30 animate-pulse"
                        : noIntensity > 0.3
                        ? "bg-red-500/25"
                        : "bg-red-500/15"
                    }`}
                    style={{ width: `${Math.max(0, noIntensity * 100)}%` }}
                  />
                  {/* Glow effect for high volume */}
                  {noIntensity > 0.5 && (
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-400/10 to-transparent animate-pulse pointer-events-none"
                      style={{ width: `${Math.max(0, noIntensity * 60)}%` }}
                    />
                  )}
                  <div className="relative flex items-center gap-2">
                    {row.noQty > 0 ? (
                      <span className="text-base font-mono font-semibold text-red-400 group-hover/no:text-red-300 tabular-nums transition-colors">
                        {formatQty(row.noQty)}
                      </span>
                    ) : (
                      <span className="text-sm text-white/10 group-hover/no:text-red-400/40 transition-colors">
                        +
                      </span>
                    )}
                    {row.noOrders > 0 && (
                      <span className="text-xs text-white/30 tabular-nums">×{row.noOrders}</span>
                    )}
                  </div>
                </button>
              </div>
            );
          })
        )}
          </div>
        </>
      )}

      {/* Expand / Collapse toggle */}
      {(hasAnyOrders || showAllLevels) && (
        <div className="border-t border-white/10 py-4 flex justify-center">
          <button
            onClick={() => setShowAllLevels(!showAllLevels)}
            className="rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 px-6 py-2 text-sm font-medium text-white/60 hover:text-white/80 transition-colors"
          >
            {showAllLevels ? "Show active levels only" : "Show all 99 levels"}
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
        onMarketCreated={onMarketCreated}
      />
    </div>
  );
}
