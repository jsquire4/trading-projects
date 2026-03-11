"use client";

import { useNetwork } from "@/hooks/useNetwork";

const FALLBACK_STYLE = "bg-white/10 text-white/50 border-white/20";

const BADGE_STYLES: Record<string, string> = {
  devnet: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  "mainnet-beta": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  localnet: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const BADGE_LABELS: Record<string, string> = {
  devnet: "Devnet",
  "mainnet-beta": "Mainnet",
  localnet: "Local",
};

export function NetworkBadge() {
  const { cluster } = useNetwork();

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${BADGE_STYLES[cluster] ?? FALLBACK_STYLE}`}
    >
      {BADGE_LABELS[cluster] ?? cluster}
    </span>
  );
}
