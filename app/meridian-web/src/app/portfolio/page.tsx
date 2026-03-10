"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWalletState } from "@/hooks/useWalletState";
import { PositionsTab } from "@/components/portfolio/PositionsTab";
import { OpenOrdersTab } from "@/components/portfolio/OpenOrdersTab";
import { TradeHistoryTab } from "@/components/portfolio/TradeHistoryTab";

type Tab = "positions" | "orders" | "history";

export default function PortfolioPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { solBalance, usdcBalance } = useWalletState();
  const [tab, setTab] = useState<Tab>("positions");

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500/20 via-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-3xl">
          💼
        </div>
        <h1 className="text-2xl font-bold text-gradient">Portfolio</h1>
        <p className="text-white/50 text-sm">Connect your wallet to view positions, orders, and history.</p>
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
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gradient mb-1">Portfolio</h1>
          <p className="text-white/50 text-sm">
            Your positions, orders, and trade history.
          </p>
        </div>
        {/* Balance summary */}
        <div className="flex items-center gap-4 text-sm">
          {solBalance !== null && (
            <div className="text-white/40">
              <span className="text-white font-medium">{solBalance.toFixed(3)}</span> SOL
            </div>
          )}
          {usdcBalance !== null && (
            <div className="text-white/40">
              <span className="text-white font-medium">${usdcBalance.toFixed(2)}</span> USDC
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-lg p-1 w-full sm:w-fit overflow-x-auto">
        {([
          { key: "positions" as Tab, label: "Positions" },
          { key: "orders" as Tab, label: "Open Orders" },
          { key: "history" as Tab, label: "Trade History" },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`shrink-0 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === key
                ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "positions" && <PositionsTab />}
      {tab === "orders" && <OpenOrdersTab />}
      {tab === "history" && <TradeHistoryTab />}
    </div>
  );
}
