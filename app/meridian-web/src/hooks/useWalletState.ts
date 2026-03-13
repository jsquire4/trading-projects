"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * USDC mint address. Override via NEXT_PUBLIC_USDC_MINT env var.
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
  | "loading"
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
// WebSocket reconnection config
// ---------------------------------------------------------------------------

const WS_INITIAL_BACKOFF_MS = 1_000;
const WS_MAX_BACKOFF_MS = 30_000;
const WS_MAX_CONSECUTIVE_FAILURES = 3;
const POLLING_FALLBACK_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Derives the wallet funding state from on-chain SOL and USDC balances.
 *
 * Uses Solana WebSocket subscriptions (connection.onAccountChange) for
 * real-time balance updates. Falls back to polling if WebSocket fails
 * 3 consecutive times with exponential backoff (1s -> 2s -> 4s -> 8s -> cap 30s).
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

  // Full balance fetch (used for initial load and polling fallback)
  const fetchBalances = useCallback(async () => {
    if (!publicKey) return;

    try {
      // Fetch SOL balance
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(lamports / 1e9);

      // Fetch all token accounts owned by this wallet
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID },
        "confirmed",
      );

      let usdc = 0;
      let nonUsdcTokensWithBalance = 0;

      for (const { account } of tokenAccounts.value) {
        const data = account.data;
        if (data.length < 72) continue;
        const mint = new PublicKey(data.subarray(0, 32));
        const amount = data.readBigUInt64LE(64);

        if (mint.equals(USDC_MINT)) {
          usdc = Number(amount) / 1e6;
        } else if (amount > BigInt(0)) {
          nonUsdcTokensWithBalance++;
        }
      }

      setUsdcBalance(usdc);
      setHasPositions(nonUsdcTokensWithBalance > 0);
    } catch (err) {
      console.error("Failed to fetch wallet balances:", err);
    }
  }, [connection, publicKey]);

  // Initial fetch + WebSocket subscriptions with reconnection logic
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      setUsdcBalance(null);
      setHasPositions(false);
      return;
    }

    let cancelled = false;
    let solSubId: number | null = null;
    let usdcSubId: number | null = null;
    let pollingInterval: ReturnType<typeof setInterval> | null = null;
    let wsFailures = 0;
    let backoffMs = WS_INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let usingPollingFallback = false;

    // Initial fetch
    fetchBalances();

    // Start polling fallback (replaces WebSocket when it fails too many times)
    function startPollingFallback() {
      if (pollingInterval || cancelled) return;
      usingPollingFallback = true;
      pollingInterval = setInterval(() => {
        if (!cancelled) fetchBalances();
      }, POLLING_FALLBACK_INTERVAL_MS);
    }

    // Stop polling fallback (when WebSocket reconnects successfully)
    function stopPollingFallback() {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      usingPollingFallback = false;
    }

    // Subscribe to SOL account changes via WebSocket
    function subscribeSol() {
      if (cancelled || !publicKey) return;
      try {
        solSubId = connection.onAccountChange(
          publicKey,
          (accountInfo) => {
            wsFailures = 0;
            backoffMs = WS_INITIAL_BACKOFF_MS;
            if (usingPollingFallback) stopPollingFallback();
            setSolBalance(accountInfo.lamports / 1e9);
          },
          "confirmed",
        );
      } catch {
        handleWsFailure();
      }
    }

    // Subscribe to USDC ATA changes via WebSocket
    async function subscribeUsdc() {
      if (cancelled || !publicKey) return;
      try {
        const usdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        if (cancelled) return;
        usdcSubId = connection.onAccountChange(
          usdcAta,
          (accountInfo) => {
            wsFailures = 0;
            backoffMs = WS_INITIAL_BACKOFF_MS;
            if (usingPollingFallback) stopPollingFallback();
            // Parse USDC balance from SPL token account data
            const data = accountInfo.data;
            if (data.length >= 72) {
              const amount = Buffer.from(data).readBigUInt64LE(64);
              setUsdcBalance(Number(amount) / 1e6);
            }
          },
          "confirmed",
        );
      } catch {
        handleWsFailure();
      }
    }

    function handleWsFailure() {
      wsFailures++;
      if (wsFailures >= WS_MAX_CONSECUTIVE_FAILURES) {
        // Switch to polling fallback
        startPollingFallback();
      } else {
        // Exponential backoff reconnect
        reconnectTimer = setTimeout(() => {
          if (!cancelled) {
            cleanupSubscriptions();
            subscribeSol();
            subscribeUsdc();
          }
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, WS_MAX_BACKOFF_MS);
      }
    }

    function cleanupSubscriptions() {
      if (solSubId !== null) {
        try { connection.removeAccountChangeListener(solSubId); } catch { /* ignore */ }
        solSubId = null;
      }
      if (usdcSubId !== null) {
        try { connection.removeAccountChangeListener(usdcSubId); } catch { /* ignore */ }
        usdcSubId = null;
      }
    }

    // Start WebSocket subscriptions
    subscribeSol();
    subscribeUsdc();

    return () => {
      cancelled = true;
      cleanupSubscriptions();
      if (pollingInterval) clearInterval(pollingInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [connection, publicKey, connected, refreshCounter, fetchBalances]);

  const state = useMemo<WalletFundingState>(() => {
    if (!connected || !publicKey) return "disconnected";
    if (solBalance === null) return "loading"; // Balances still loading
    if (solBalance === 0) return "unfunded";
    if (usdcBalance === null || usdcBalance === 0) return "no-usdc";
    if (hasPositions) return "has-positions";
    return "funded";
  }, [connected, publicKey, solBalance, usdcBalance, hasPositions]);

  return { state, solBalance, usdcBalance, refresh };
}
