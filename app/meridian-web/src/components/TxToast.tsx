"use client";

import { toast } from "sonner";
import { getExplorerUrl } from "@/lib/network";

interface TxToastParams {
  signature: string;
  status: "confirmed" | "error";
  error?: string;
}

export function showTxToast({ signature, status, error }: TxToastParams) {
  if (status === "confirmed") {
    const explorerUrl = getExplorerUrl(signature);
    toast.success("Transaction confirmed", {
      description: (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline text-xs"
        >
          View on Explorer
        </a>
      ),
      duration: 6000,
    });
  } else {
    toast.error("Transaction failed", {
      description: (
        <span className="text-xs text-white/70">{error ?? "Unknown error"}</span>
      ),
      duration: 8000,
    });
  }
}
