"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { useNetwork } from "@/hooks/useNetwork";

export function FaucetButton() {
  const { isMainnet } = useNetwork();
  const { publicKey } = useWallet();
  const [loading, setLoading] = useState(false);

  // Only visible on devnet/localnet
  if (isMainnet) return null;

  const handleClick = async () => {
    if (!publicKey) {
      toast.error("Connect your wallet first");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/faucet/usdc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error("Faucet failed", {
          description: data.error ?? "Unknown error",
        });
        return;
      }

      toast.success("Test USDC sent!", {
        description: `Signature: ${data.signature?.slice(0, 16)}...`,
        duration: 5000,
      });
    } catch (err) {
      toast.error("Faucet request failed", {
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading || !publicKey}
      className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? "Requesting..." : "Get Test USDC"}
    </button>
  );
}
