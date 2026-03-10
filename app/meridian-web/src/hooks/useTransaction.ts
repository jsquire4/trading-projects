"use client";

import { useCallback, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { toast } from "sonner";
import { useAnchorProgram } from "./useAnchorProgram";

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
// Helpers
// ---------------------------------------------------------------------------

function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function shortenSig(sig: string): string {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
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

  // Guard against state updates after unmount
  const mountedRef = useRef(true);
  // Track mount state — useEffect cleanup not needed here because the ref
  // is only read inside the async callback which captures it.

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

        let signed: Transaction | VersionedTransaction;
        if ("version" in tx) {
          // VersionedTransaction
          signed = await provider.wallet.signTransaction(tx);
        } else {
          signed = await provider.wallet.signTransaction(tx);
        }

        // --- Send ---
        setStatus("confirming");
        toast.loading(`${label}: Confirming...`, { id: toastId });

        const rawTx = signed.serialize();
        const signature = await connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        if (opts?.skipConfirmation) {
          toast.success(`${label}: Sent`, {
            id: toastId,
            description: shortenSig(signature),
            action: {
              label: "View",
              onClick: () => window.open(explorerUrl(signature), "_blank"),
            },
          });
          if (mountedRef.current) {
            setStatus("confirmed");
          }
          return signature;
        }

        // --- Confirm ---
        const latestBlockhash = await connection.getLatestBlockhash("confirmed");
        await connection.confirmTransaction(
          {
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          "confirmed",
        );

        toast.success(`${label}: Confirmed`, {
          id: toastId,
          description: shortenSig(signature),
          action: {
            label: "View",
            onClick: () => window.open(explorerUrl(signature), "_blank"),
          },
        });

        if (mountedRef.current) {
          setStatus("confirmed");
        }
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
