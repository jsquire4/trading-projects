"use client";

import { useState, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/useMarkets";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useWalletState } from "@/hooks/useWalletState";
import { QuoteTable } from "@/components/mm/QuoteTable";
import { AggregateStats } from "@/components/mm/AggregateStats";
import { CreateMarketForm } from "@/components/admin/CreateMarketForm";
import { MarketActions } from "@/components/admin/MarketActions";
import { findGlobalConfig } from "@/lib/pda";
import { useQuery } from "@tanstack/react-query";

type Tab = "mm" | "admin";

export default function MarketMakerPage() {
  const [tab, setTab] = useState<Tab>("mm");
  const { publicKey, connected } = useWallet();
  const { program } = useAnchorProgram();
  const { data: markets = [] } = useMarkets();
  const { usdcBalance } = useWalletState();

  // Fetch admin address from GlobalConfig
  const { data: adminPubkey } = useQuery({
    queryKey: ["global-config-admin"],
    queryFn: async () => {
      if (!program) return null;
      const [configAddr] = findGlobalConfig();
      const config = await program.account.globalConfig.fetch(configAddr);
      return (config as any).admin?.toBase58() ?? null;
    },
    enabled: !!program,
    staleTime: 60_000,
  });

  const isAdmin = connected && publicKey && adminPubkey === publicKey.toBase58();

  const activeMarkets = useMemo(
    () => markets.filter((m) => !m.isSettled && !m.isClosed),
    [markets],
  );

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Market Maker</h1>
        <p className="text-white/50 text-sm">Connect wallet to view market maker dashboard.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient mb-1">
            {tab === "mm" ? "Market Maker" : "Admin"}
          </h1>
          <p className="text-white/50 text-sm">
            {tab === "mm"
              ? "Monitor quotes, spreads, and inventory across all markets."
              : "Create markets, settle, pause, and manage overrides."}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-lg p-1 w-full sm:w-fit">
        <button
          onClick={() => setTab("mm")}
          className={`flex-1 sm:flex-none px-4 py-2 rounded-md text-sm font-medium transition-all ${
            tab === "mm"
              ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
              : "text-white/40 hover:text-white/70"
          }`}
        >
          Market Maker
        </button>
        {isAdmin && (
          <button
            onClick={() => setTab("admin")}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === "admin"
                ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            Admin
          </button>
        )}
      </div>

      {/* Tab content */}
      {tab === "mm" ? (
        <div className="space-y-6">
          <AggregateStats
            marketsCount={activeMarkets.length}
            totalMarkets={markets.length}
            usdcBalance={usdcBalance}
          />
          <QuoteTable markets={activeMarkets} />
        </div>
      ) : isAdmin ? (
        <div className="space-y-6">
          <CreateMarketForm />
          <MarketActions markets={markets} />
        </div>
      ) : null}
    </div>
  );
}
