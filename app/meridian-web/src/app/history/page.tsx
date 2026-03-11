"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { TradeHistoryTab } from "@/components/portfolio/TradeHistoryTab";
import { EventIndexerBanner } from "@/components/EventIndexerBanner";

export default function HistoryPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500/20 via-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-3xl">
          📜
        </div>
        <h1 className="text-2xl font-bold text-gradient">Trade History</h1>
        <p className="text-white/50 text-sm">Connect your wallet to view your trade history.</p>
        <button
          onClick={() => setVisible(true)}
          className="bg-gradient-to-r from-green-500 via-blue-500 to-purple-500 hover:from-green-400 hover:via-blue-400 hover:to-purple-400 text-white font-semibold rounded-lg px-6 py-2.5 transition-all text-sm"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gradient mb-1">Trade History</h1>
        <p className="text-white/50 text-sm">
          Your completed fills across all markets.
        </p>
      </div>
      <EventIndexerBanner />
      <TradeHistoryTab />
    </div>
  );
}
