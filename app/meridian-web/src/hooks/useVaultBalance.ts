"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultBalance {
  /** Human-readable USDC amount (lamports / 1e6). */
  balance: number;
  /** Raw lamports. */
  lamports: bigint;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Generic vault balance hook. Fetches the token account balance for an
 * arbitrary SPL token account address. Used by useTreasuryBalance and
 * useFeeVaultBalance to avoid duplicated fetch/parse logic.
 */
export function useVaultBalance(address: PublicKey, queryKey: string) {
  const { connection } = useConnection();

  return useQuery<VaultBalance | null>({
    queryKey: [queryKey],
    queryFn: async () => {
      try {
        const resp = await connection.getTokenAccountBalance(address, "confirmed");
        const lamports = BigInt(resp.value.amount);
        return {
          balance: Number(lamports / 1_000_000n) + Number(lamports % 1_000_000n) / 1e6,
          lamports,
        };
      } catch {
        return null;
      }
    },
    enabled: !!connection,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
