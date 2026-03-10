"use client";

import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useRef } from "react";

// Still need the multi-button for the connected dropdown (disconnect, copy, etc.)
const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

/**
 * Custom wallet button that:
 * - Shows "Connect Wallet" when disconnected (compact size)
 * - Only persists the wallet choice after a successful connection
 * - Falls back to the standard multi-button when connected (for disconnect UI)
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { connected, publicKey, wallet, disconnect, select } = useWallet();
  const { setVisible } = useWalletModal();
  const hasConnectedRef = useRef(false);

  // Track successful connections
  useEffect(() => {
    if (connected && publicKey) {
      hasConnectedRef.current = true;
    }
  }, [connected, publicKey]);

  // If wallet was selected but never actually connected, clear it on unmount
  useEffect(() => {
    return () => {
      if (wallet && !hasConnectedRef.current) {
        // Clear the persisted wallet name so it doesn't auto-select next time
        try {
          localStorage.removeItem("walletName");
        } catch {
          // ignore
        }
      }
    };
  }, [wallet]);

  const handleClick = useCallback(() => {
    if (connected) return; // multi-button handles connected state
    setVisible(true);
  }, [connected, setVisible]);

  // Connected: use the standard multi-button for its dropdown UI
  if (connected) {
    return (
      <WalletMultiButton
        className={`!bg-accent hover:!bg-accent/80 !text-sm !h-9 !px-4 !rounded-lg !font-medium ${
          compact ? "!text-xs !h-8 !px-3" : ""
        }`}
      />
    );
  }

  // Disconnected: custom compact button
  return (
    <button
      onClick={handleClick}
      className={`bg-white/10 hover:bg-white/15 text-white/70 hover:text-white border border-white/10 hover:border-white/20 rounded-lg font-medium transition-all ${
        compact
          ? "text-xs px-3 py-1.5"
          : "text-sm px-4 py-2"
      }`}
    >
      Connect Wallet
    </button>
  );
}
