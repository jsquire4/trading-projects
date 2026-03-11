"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { toast } from "sonner";
import { useAnchorProgram } from "./useAnchorProgram";
import { getExplorerUrl } from "../lib/network";

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
          toast.success(`${label}: Sent`, {
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

        toast.success(`${label}: Confirmed`, {
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
