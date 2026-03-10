"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * USDC mint address on devnet. Override via NEXT_PUBLIC_USDC_MINT env var.
 */
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ??
    // Default: USDC devnet mint (Circle's devnet faucet token)
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletFundingState =
  | "disconnected"
  | "unfunded"
  | "no-usdc"
  | "funded"
  | "has-positions";

interface UseWalletStateReturn {
  state: WalletFundingState;
  solBalance: number | null;
  /** USDC balance in human-readable units (6 decimals). */
  usdcBalance: number | null;
  /** Trigger a manual refresh of balances. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Derives the wallet funding state from on-chain SOL and USDC balances.
 *
 * States flow: disconnected → unfunded → no-usdc → funded → has-positions
 *
 * The `has-positions` state is set when the wallet holds any SPL token
 * accounts beyond the USDC account (heuristic — Yes/No token mints are
 * per-market so we check for any non-USDC SPL token balance > 0).
 */
export function useWalletState(): UseWalletStateReturn {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [hasPositions, setHasPositions] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      setUsdcBalance(null);
      setHasPositions(false);
      return;
    }

    let cancelled = false;

    async function fetchBalances() {
      if (!publicKey) return;

      try {
        // Fetch SOL balance
        const lamports = await connection.getBalance(publicKey, "confirmed");
        if (cancelled) return;
        setSolBalance(lamports / 1e9);

        // Fetch all token accounts owned by this wallet
        const tokenAccounts = await connection.getTokenAccountsByOwner(
          publicKey,
          { programId: TOKEN_PROGRAM_ID },
          "confirmed",
        );
        if (cancelled) return;

        let usdc = 0;
        let nonUsdcTokensWithBalance = 0;

        for (const { account } of tokenAccounts.value) {
          // SPL token account data layout:
          // bytes 0-31:  mint
          // bytes 32-63: owner
          // bytes 64-71: amount (u64 LE)
          const data = account.data;
          const mint = new PublicKey(data.subarray(0, 32));
          const amount = data.readBigUInt64LE(64);

          if (mint.equals(USDC_MINT)) {
            // USDC has 6 decimals
            usdc = Number(amount) / 1e6;
          } else if (amount > BigInt(0)) {
            nonUsdcTokensWithBalance++;
          }
        }

        if (!cancelled) {
          setUsdcBalance(usdc);
          setHasPositions(nonUsdcTokensWithBalance > 0);
        }
      } catch (err) {
        // Silently fail — user can retry with refresh()
        console.error("Failed to fetch wallet balances:", err);
      }
    }

    fetchBalances();

    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, connected, refreshCounter]);

  const state = useMemo<WalletFundingState>(() => {
    if (!connected || !publicKey) return "disconnected";
    if (solBalance === null) return "disconnected"; // Still loading
    if (solBalance === 0) return "unfunded";
    if (usdcBalance === null || usdcBalance === 0) return "no-usdc";
    if (hasPositions) return "has-positions";
    return "funded";
  }, [connected, publicKey, solBalance, usdcBalance, hasPositions]);

  return { state, solBalance, usdcBalance, refresh };
}
