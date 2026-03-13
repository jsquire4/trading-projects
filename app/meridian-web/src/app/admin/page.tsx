"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/useMarkets";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { CreateMarketForm } from "@/components/admin/CreateMarketForm";
import { MarketActions } from "@/components/admin/MarketActions";
import { findGlobalConfig } from "@/lib/pda";
import { useQuery } from "@tanstack/react-query";

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { program } = useAnchorProgram();
  const { data: markets = [] } = useMarkets();

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

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-gradient">Admin</h1>
        <p className="text-white/50 text-sm">Connect wallet to access admin controls.</p>
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
        <h1 className="text-2xl font-bold text-gradient mb-1">Admin</h1>
        <p className="text-white/50 text-sm">
          Create markets, settle, pause, and manage overrides.
        </p>
      </div>
      <div className="space-y-6">
        <CreateMarketForm />
        <MarketActions markets={markets} />
      </div>
    </div>
  );
}
