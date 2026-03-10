import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian — Binary Stock Outcomes",
  description: "Trade binary stock outcome markets on Solana",
};

const navLinks = [
  { href: "/", label: "Home" },
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
          <header className="border-b border-white/10 px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="text-xl font-bold tracking-tight">
                Meridian
              </Link>
              <nav className="flex gap-6">
                {navLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-sm text-white/60 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
            <WalletButton />
          </header>
          <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
          <Toaster theme="dark" position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
