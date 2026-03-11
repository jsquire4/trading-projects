import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { NavPnl } from "@/components/NavPnl";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian — Binary Stock Outcomes",
  description: "Trade binary stock outcome markets on Solana",
};

const navLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/history", label: "History" },
  { href: "/analytics", label: "Analytics" },
  { href: "/market-maker", label: "Market Maker" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="border-b border-white/10 px-3 sm:px-6 py-3 flex items-center justify-between backdrop-blur-sm bg-black/30 gap-2">
            <div className="flex items-center gap-4 sm:gap-8 min-w-0">
              <Link href="/" className="text-lg sm:text-xl font-bold tracking-tight text-gradient shrink-0">
                Meridian
              </Link>
              <nav className="flex gap-3 sm:gap-6 overflow-x-auto scrollbar-hide">
                {navLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-xs sm:text-sm text-white/60 hover:text-white transition-colors whitespace-nowrap shrink-0"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <NavPnl />
              <WalletButton />
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-3 sm:px-6 py-6 sm:py-8">{children}</main>
          <Toaster theme="dark" position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
