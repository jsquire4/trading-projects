"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { findFeeVault } from "@/lib/pda";

export interface VaultBalance {
  /** Human-readable USDC amount (lamports / 1e6). */
  balance: number;
  /** Raw lamports. */
  lamports: bigint;
}

export function useFeeVaultBalance() {
  const { connection } = useConnection();
  const [feeVaultAddr] = findFeeVault();

  return useQuery<VaultBalance | null>({
    queryKey: ["fee-vault-balance"],
    queryFn: async () => {
      try {
        const resp = await connection.getTokenAccountBalance(feeVaultAddr, "confirmed");
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
