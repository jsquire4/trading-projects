"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { useNetwork } from "@/hooks/useNetwork";
import { WALLET_REFRESH_EVENT } from "@/hooks/useWalletState";

interface FaucetButtonProps {
  className?: string;
}

export function FaucetButton({ className }: FaucetButtonProps) {
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

      // Trigger immediate balance refresh in NavBalance
      window.dispatchEvent(new Event(WALLET_REFRESH_EVENT));

      if (data.solAirdropFailed) {
        toast.warning(`${data.amount} USDC sent, but SOL airdrop failed`, {
          description: data.isDevnet
            ? "Solana devnet rate-limits SOL airdrops. This is a Solana network limitation, not a Meridian issue. Visit faucet.solana.com to request devnet SOL manually."
            : "SOL airdrop failed unexpectedly. Try again in a moment.",
          duration: 10000,
        });
      } else {
        toast.success(data.solAirdropped ? "SOL + USDC sent!" : "Test USDC sent!", {
          description: `${data.solAirdropped ? "2 SOL + " : ""}${data.amount} USDC`,
          duration: 5000,
        });
      }
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
      className={className ?? "rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"}
    >
      {loading ? "Requesting..." : "Get Test Funds"}
    </button>
  );
}
