"use client";

import { findTreasury } from "@/lib/pda";
import { useVaultBalance, type VaultBalance } from "./useVaultBalance";

export type { VaultBalance as TreasuryBalance };

export function useTreasuryBalance() {
  const [treasuryAddr] = findTreasury();
  return useVaultBalance(treasuryAddr, "treasury-balance");
}
