"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletState } from "@/hooks/useWalletState";

export function NavBalance() {
  const { connected } = useWallet();
  const { solBalance, usdcBalance } = useWalletState();

  if (!connected || solBalance === null) return null;

  return (
    <div className="hidden sm:flex items-center gap-2.5 px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-xs shrink-0">
      <span className="font-mono text-white/70">
        {solBalance.toFixed(2)} <span className="text-white/40">SOL</span>
      </span>
      <span className="text-white/10">|</span>
      <span className="font-mono text-white/70">
        {(usdcBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-white/40">USDC</span>
      </span>
    </div>
  );
}
