"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useIndexedEvents } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";

export interface CostBasisEntry {
  market: string;         // market pubkey
  avgPrice: number;       // weighted average fill price in cents
  totalQuantity: number;  // total tokens acquired (in token units, not micro)
  totalCostUsdc: number;  // total USDC spent
}

/**
 * Derives cost basis per market from fill events for the connected wallet.
 * Returns a Map<marketKey, CostBasisEntry>.
 *
 * Only buy-side fills are counted:
 *   - When this wallet is the taker: takerSide 0 (Buy Yes) or 2 (Buy No)
 *   - When this wallet is the maker: takerSide 1 (Sell Yes), meaning the maker
 *     was on the buy side of the opposite leg
 *
 * Prices are stored in cents; quantities are stored in micro-tokens (1e6 = 1 token).
 */
export function useCostBasis() {
  const { publicKey } = useWallet();
  // useIndexedEvents caps limit at 1000 internally
  const { data: events = [], isLoading } = useIndexedEvents({ type: "fill", limit: 1000 });

  const costBasis = useMemo(() => {
    const map = new Map<string, CostBasisEntry>();
    if (!publicKey) return map;
    const walletStr = publicKey.toBase58();

    for (const event of events) {
      const fill = parseFillEvent(event);
      if (!fill || !fill.market) continue;

      // Only count fills where this wallet participated
      const isMaker = fill.maker === walletStr;
      const isTaker = fill.taker === walletStr;
      if (!isMaker && !isTaker) continue;

      // Determine if this was a buy for this wallet.
      // takerSide: 0 = Buy Yes, 1 = Sell Yes, 2 = Buy No
      // If we're the taker, our side is takerSide directly.
      // If we're the maker, we're on the opposite side of takerSide.
      const isBuy = isTaker
        ? fill.takerSide === 0 || fill.takerSide === 2
        : fill.takerSide === 1; // taker sold → maker bought

      if (!isBuy) continue; // Only track purchases for cost basis

      const qty = fill.quantity / 1_000_000;   // micro-tokens → tokens
      const priceUsdc = fill.price / 100;       // cents → USDC per contract

      const existing = map.get(fill.market);
      if (existing) {
        const newTotalQty = existing.totalQuantity + qty;
        const newTotalCost = existing.totalCostUsdc + qty * priceUsdc;
        map.set(fill.market, {
          market: fill.market,
          totalQuantity: newTotalQty,
          totalCostUsdc: newTotalCost,
          avgPrice: newTotalQty > 0 ? (newTotalCost / newTotalQty) * 100 : 0, // back to cents
        });
      } else {
        map.set(fill.market, {
          market: fill.market,
          totalQuantity: qty,
          totalCostUsdc: qty * priceUsdc,
          avgPrice: fill.price,
        });
      }
    }

    return map;
  }, [events, publicKey]);

  return { costBasis, isLoading };
}
