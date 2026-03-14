"use client";

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { useAnchorProgram } from "./useAnchorProgram";
import { findTickerRegistry } from "@/lib/pda";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TickerEntry {
  ticker: string;
  isActive: boolean;
  pythFeed: PublicKey;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTickerRegistry() {
  const { program } = useAnchorProgram();
  const [registryAddr] = findTickerRegistry();

  return useQuery<TickerEntry[]>({
    queryKey: ["ticker-registry"],
    queryFn: async () => {
      if (!program) return [];
      try {
        const raw = await program.account.tickerRegistry.fetch(registryAddr) as Record<string, unknown>;
        const entries = raw.entries as Array<Record<string, unknown>>;

        return entries.map((entry) => {
          const tickerBytes = entry.ticker as number[];
          const ticker = Buffer.from(tickerBytes)
            .toString("utf-8")
            .replace(/\0+$/, "");
          return {
            ticker,
            isActive: entry.isActive as boolean,
            pythFeed: entry.pythFeed as PublicKey,
          };
        });
      } catch {
        return [];
      }
    },
    enabled: !!program,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
