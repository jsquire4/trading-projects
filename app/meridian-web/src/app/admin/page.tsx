"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { AdminOverview } from "@/components/admin/tabs/AdminOverview";
import { FeesRevenue } from "@/components/admin/tabs/FeesRevenue";
import { MarketsPanel } from "@/components/admin/tabs/MarketsPanel";
import { PlatformSettings } from "@/components/admin/tabs/PlatformSettings";
import { TickerManagement } from "@/components/admin/tabs/TickerManagement";

type AdminTab = "overview" | "fees" | "markets" | "settings" | "tickers";

const TABS: { key: AdminTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "fees", label: "Fees & Revenue" },
  { key: "markets", label: "Markets" },
  { key: "settings", label: "Settings" },
  { key: "tickers", label: "Tickers" },
];

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { data: config, isLoading } = useGlobalConfig();
  const [tab, setTab] = useState<AdminTab>("overview");

  const isAdmin = connected && publicKey && config?.admin.toBase58() === publicKey.toBase58();

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Admin</h1>
        <p className="text-white/50 text-sm">Connect wallet to access admin controls.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Admin</h1>
        <div className="h-4 w-32 bg-white/5 rounded animate-pulse" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Admin</h1>
        <p className="text-white/50 text-sm">
          GlobalConfig not initialized. Run the CLI initialization script first.
        </p>
        <code className="text-xs text-white/30 bg-white/5 rounded px-3 py-1.5">
          npx ts-node scripts/initialize-platform.ts
        </code>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Admin</h1>
        <p className="text-white/50 text-sm">Only the protocol admin can access this page.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gradient mb-1">Admin Dashboard</h1>
        <p className="text-white/50 text-sm">
          Manage fees, markets, settings, and tickers.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-lg p-1 w-full sm:w-fit overflow-x-auto">
        {TABS.map(({ key, label }) => (
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
      {tab === "overview" && <AdminOverview />}
      {tab === "fees" && <FeesRevenue />}
      {tab === "markets" && <MarketsPanel />}
      {tab === "settings" && <PlatformSettings />}
      {tab === "tickers" && <TickerManagement />}
    </div>
  );
}
