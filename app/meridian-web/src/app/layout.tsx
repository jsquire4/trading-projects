import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { NavPnl } from "@/components/NavPnl";
import { NavBalance } from "@/components/NavBalance";
import { NetworkBadge } from "@/components/NetworkBadge";
import { Nav } from "@/components/Nav";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian — Binary Stock Outcomes",
  description: "Trade binary stock outcome markets on Solana",
};

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
              <Nav />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <NavPnl />
              <NavBalance />
              <NetworkBadge />
              <WalletButton />
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-3 sm:px-6 py-6 sm:py-8">{children}</main>
          <footer className="border-t border-white/5 px-3 sm:px-6 py-3 text-center text-[10px] text-white/20">
            Meridian is experimental software. Trading binary outcomes involves risk of loss. Not financial advice.
          </footer>
          <Toaster theme="dark" position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
