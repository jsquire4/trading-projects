"use client";

import { findFeeVault } from "@/lib/pda";
import { useVaultBalance, type VaultBalance } from "./useVaultBalance";

export type { VaultBalance };

export function useFeeVaultBalance() {
  const [feeVaultAddr] = findFeeVault();
  return useVaultBalance(feeVaultAddr, "fee-vault-balance");
}
