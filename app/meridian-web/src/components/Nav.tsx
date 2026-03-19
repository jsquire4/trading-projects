"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";

const baseLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/history", label: "History" },
  { href: "/signals", label: "Signals" },
];

export function Nav() {
  const { publicKey } = useWallet();
  const { data: config } = useGlobalConfig();

  const isAdmin =
    publicKey && config?.admin && config.admin.equals(publicKey);

  return (
    <nav className="flex gap-3 sm:gap-6 overflow-x-auto scrollbar-hide">
      {baseLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-xs sm:text-sm text-white/60 hover:text-white transition-colors whitespace-nowrap shrink-0"
        >
          {link.label}
        </Link>
      ))}
      {isAdmin && (
        <Link
          href="/admin"
          className="text-xs sm:text-sm text-white/60 hover:text-white transition-colors whitespace-nowrap shrink-0"
        >
          Admin
        </Link>
      )}
    </nav>
  );
}
