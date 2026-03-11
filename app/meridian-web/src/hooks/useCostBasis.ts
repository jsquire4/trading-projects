"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";

export interface CostBasisEntry {
  market: string;         // market pubkey
  avgPrice: number;       // weighted average fill price in cents
  totalQuantity: number;  // total tokens acquired (in token units, not micro)
  totalCostUsdc: number;  // total USDC spent
}

const EVENT_INDEXER_URL = process.env.NEXT_PUBLIC_EVENT_INDEXER_URL ?? "http://localhost:4800";

/**
 * Derives cost basis per market from fill events for the connected wallet.
 * Returns a Map<marketKey, CostBasisEntry>.
 *
 * Uses the server-side /api/events/cost-basis endpoint which aggregates
 * all fill events via SQL — no client-side cap or truncation.
 */
export function useCostBasis() {
  const { publicKey } = useWallet();

  const { data: costBasis = new Map(), isLoading } = useQuery<Map<string, CostBasisEntry>>({
    queryKey: ["cost-basis", publicKey?.toBase58() ?? null],
    queryFn: async () => {
      if (!publicKey) return new Map();
      const wallet = publicKey.toBase58();
      const res = await fetch(
        `${EVENT_INDEXER_URL}/api/events/cost-basis?wallet=${encodeURIComponent(wallet)}`,
      );
      if (!res.ok) throw new Error(`Cost basis fetch failed: ${res.status}`);
      const json = await res.json();
      const map = new Map<string, CostBasisEntry>();
      for (const row of json.costBasis ?? []) {
        const qty = row.totalQuantity / 1_000_000;  // micro → tokens
        const costUsdc = row.totalCostUsdc / (1_000_000 * 100); // micro-tokens × cents → USDC
        map.set(row.market, {
          market: row.market,
          totalQuantity: qty,
          totalCostUsdc: costUsdc,
          avgPrice: row.avgPrice, // already in cents
        });
      }
      return map;
    },
    enabled: !!publicKey,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  return { costBasis, isLoading };
}
