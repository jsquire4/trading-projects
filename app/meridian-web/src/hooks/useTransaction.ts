"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { toast } from "sonner";
import { useAnchorProgram } from "./useAnchorProgram";
import { getExplorerUrl } from "../lib/network";
import { WALLET_REFRESH_EVENT } from "./useWalletState";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransactionStatus =
  | "idle"
  | "signing"
  | "confirming"
  | "confirmed"
  | "error";

interface UseTransactionReturn {
  sendTransaction: (
    tx: Transaction | VersionedTransaction,
    opts?: SendOptions,
  ) => Promise<string | null>;
  status: TransactionStatus;
  error: string | null;
}

interface SendOptions {
  /** Toast title shown while confirming. Defaults to "Transaction". */
  description?: string;
  /** If true, skip the confirmation wait (fire-and-forget). */
  skipConfirmation?: boolean;
}

// ---------------------------------------------------------------------------
// Meridian program error codes → user-friendly messages
// ---------------------------------------------------------------------------

const PROGRAM_ERRORS: Record<number, string> = {
  // Authorization
  6000: "Admin access required",
  6001: "Invalid oracle authority",
  6002: "Signer mismatch",
  // Config
  6010: "Config already initialized",
  6011: "Oracle feed already exists",
  6012: "Ticker not recognized",
  6013: "Close time is in the past",
  6014: "Strike price cannot be zero",
  6015: "Invalid staleness threshold",
  6016: "Invalid confidence threshold",
  // Market state
  6020: "Market already settled",
  6021: "Market not yet settled",
  6022: "Trading is paused",
  6023: "Already paused",
  6024: "Not currently paused",
  6025: "Market is closed",
  // Account validation
  6030: "Mint mismatch",
  6031: "Invalid vault",
  6032: "Invalid escrow",
  6033: "Invalid order book",
  6034: "Invalid market",
  6035: "Account not initialized",
  6036: "Invalid program",
  6037: "Not enough accounts for fill",
  6038: "Invalid maker account",
  // Oracle
  6040: "Oracle price is stale",
  6041: "Oracle confidence too wide",
  6042: "Oracle not initialized",
  6043: "Oracle price invalid",
  6044: "Oracle program mismatch",
  6045: "Invalid oracle discriminator",
  // Trading
  6050: "Insufficient balance",
  6051: "Order book full at this price",
  6052: "Price must be 1-99",
  6053: "Quantity too small (min 1 token)",
  6054: "Order not found",
  6055: "Cannot cancel another user's order",
  6056: "No matching orders available",
  6057: "Invalid order type",
  6058: "Invalid order side",
  6059: "Conflicting position (Yes + No)",
  // Balance
  6060: "Vault balance invariant violated",
  6061: "Mint supply invariant violated",
  6062: "Vault cannot cover payout",
  6063: "Token transfer failed",
  6064: "Token mint failed",
  6065: "Token burn failed",
  6066: "Token account creation failed",
  // Settlement
  6070: "Market hasn't closed yet",
  6071: "Must wait 1 hour after close for admin settle",
  6072: "Override window has expired",
  6074: "Invalid outcome value",
  6075: "Max overrides (3) exceeded",
  // Redemption
  6080: "Redemption blocked during override window",
  6081: "No tokens to redeem",
  6082: "Invalid redemption mode",
  // Crank
  6090: "Order book already empty",
  // Arithmetic
  6100: "Arithmetic overflow",
  6101: "Division by zero",
  // Market closure
  6110: "Market not settled — cannot close",
  6111: "Override window still active",
  6112: "Cancel resting orders first",
  6113: "90-day grace period not elapsed",
  6114: "Invalid oracle type",
  6115: "Pyth feed mismatch",
  6116: "Market not closed — use standard redeem",
  6117: "Tokens still outstanding — cannot cleanup",
  6118: "Treasury has insufficient USDC",
  // ALT
  6120: "ALT address already set",
  // Fees
  6130: "Fee exceeds maximum (10%)",
  6131: "Fee transfer failed",
  // Crank redeem
  6140: "Override window still active",
  6141: "No tokens redeemed in batch",
  // Admin V2
  6150: "No pending admin transfer",
  6151: "Not the pending admin",
  6152: "Withdrawal exceeds available balance",
  6153: "Ticker already exists",
  6154: "Ticker not found",
  6155: "Ticker is deactivated",
  6156: "Config already expanded",
  6157: "Pyth validation required",
  6158: "Invalid Pyth feed",
  6159: "Unsettled markets exist",
  6160: "Invalid operating reserve",
  6161: "Blackout must be 0-60 minutes",
  6162: "Treasury needs more SOL for rent",
  6163: "Admin required for mock oracle",
  // Sparse order book
  6170: "Order book data too small",
  6171: "Order book discriminator mismatch",
  6172: "Insufficient SOL for rent deposit",
  6173: "Order book at max levels",
  6174: "Order book at max slots per level",
  6175: "Order book already initialized",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenSig(sig: string): string {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
}

/**
 * Resolve the full error text from a transaction error.
 * Calls getLogs() on SendTransactionError for complete program logs,
 * then scans all available text for error codes and known patterns.
 */
function extractErrorMessage(err: unknown): string {
  // Gather all available error text: message + logs
  let raw = err instanceof Error ? err.message : String(err ?? "Unknown error");

  // Call getLogs() on SendTransactionError for full program output
  if (err && typeof err === "object") {
    if (typeof (err as any).getLogs === "function") {
      try {
        const logs: string[] = (err as any).getLogs() ?? [];
        if (logs.length > 0) raw += "\n" + logs.join("\n");
      } catch { /* ignore */ }
    } else if ("logs" in err) {
      const logs = (err as any).logs as string[] | undefined;
      if (logs?.length) raw += "\n" + logs.join("\n");
    }
  }

  // 1. Try to extract a hex error code (e.g. "custom program error: 0x1786")
  const hexMatch = raw.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hexMatch) {
    const code = parseInt(hexMatch[1], 16);
    const friendly = PROGRAM_ERRORS[code];
    if (friendly) return friendly;
    return `Program error ${code}`;
  }

  // 2. Anchor error codes in decimal (e.g. "Error Code: MarketPaused. Error Number: 6022")
  const decMatch = raw.match(/Error Number: (\d+)/);
  if (decMatch) {
    const code = parseInt(decMatch[1], 10);
    const friendly = PROGRAM_ERRORS[code];
    if (friendly) return friendly;
  }

  // 3. Common wallet/network/runtime errors — clean up to short messages
  const lower = raw.toLowerCase();
  if (lower.includes("user rejected") || lower.includes("user denied"))
    return "Transaction cancelled";
  if (lower.includes("insufficient funds") || lower.includes("insufficient lamports"))
    return "Insufficient SOL for transaction fees";
  if (lower.includes("debit an account") || lower.includes("no record of a prior credit"))
    return "Account not funded — request SOL and USDC from the faucet first";
  if (lower.includes("blockhash") || lower.includes("block height exceeded"))
    return "Transaction expired — please try again";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "Network timeout — please try again";
  if (lower.includes("socket hang up") || lower.includes("failed to fetch"))
    return "Network error — check your connection";
  if (lower.includes("not connected"))
    return "Wallet not connected";

  // 4. Strip the verbose "Transaction simulation failed..." prefix
  const simMatch = raw.match(/Transaction simulation failed:.*?custom program error: (.+?)[\.\s]/);
  if (simMatch) return `Program error: ${simMatch[1]}`;

  // 5. If still long, truncate to something reasonable
  if (raw.length > 120) return raw.slice(0, 117) + "...";

  return raw;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Wraps the full sign → send → confirm lifecycle with loading states
 * and sonner toast notifications.
 */
export function useTransaction(): UseTransactionReturn {
  const { connection } = useConnection();
  const { provider } = useAnchorProgram();
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const sendTransaction = useCallback(
    async (
      tx: Transaction | VersionedTransaction,
      opts?: SendOptions,
    ): Promise<string | null> => {
      const label = opts?.description ?? "Transaction";

      if (!provider) {
        const msg = "Wallet not connected";
        toast.error(msg);
        setError(msg);
        setStatus("error");
        return null;
      }

      setError(null);
      setStatus("signing");

      let toastId: string | number | undefined;

      try {
        // --- Sign ---
        toastId = toast.loading(`${label}: Awaiting signature...`);

        // Fetch blockhash once and reuse for both signing and confirmation
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");

        if (!("version" in tx)) {
          tx.recentBlockhash = blockhash;
          tx.lastValidBlockHeight = lastValidBlockHeight;
          tx.feePayer = provider.wallet.publicKey;
        }

        const signed = await provider.wallet.signTransaction(tx);

        // --- Send ---
        if (!mountedRef.current) return null;
        setStatus("confirming");
        toast.loading(`${label}: Confirming...`, { id: toastId });

        const rawTx = signed.serialize();
        const signature = await connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        if (opts?.skipConfirmation) {
          toast.success(label, {
            id: toastId,
            description: shortenSig(signature),
            action: {
              label: "View",
              onClick: () => window.open(getExplorerUrl(signature), "_blank"),
            },
          });
          if (mountedRef.current) {
            setStatus("confirmed");
          }
          window.dispatchEvent(new Event(WALLET_REFRESH_EVENT));
          return signature;
        }

        // --- Confirm (reuse same blockhash) ---
        await connection.confirmTransaction(
          {
            signature,
            blockhash,
            lastValidBlockHeight,
          },
          "confirmed",
        );

        toast.success(label, {
          id: toastId,
          description: shortenSig(signature),
          action: {
            label: "View",
            onClick: () => window.open(getExplorerUrl(signature), "_blank"),
          },
        });

        if (mountedRef.current) {
          setStatus("confirmed");
        }
        window.dispatchEvent(new Event(WALLET_REFRESH_EVENT));
        return signature;
      } catch (err) {
        const msg = extractErrorMessage(err);

        if (toastId !== undefined) {
          toast.error(`${label}: Failed`, {
            id: toastId,
            description: msg,
          });
        } else {
          toast.error(`${label}: Failed`, { description: msg });
        }

        if (mountedRef.current) {
          setError(msg);
          setStatus("error");
        }
        return null;
      }
    },
    [connection, provider],
  );

  return { sendTransaction, status, error };
}
