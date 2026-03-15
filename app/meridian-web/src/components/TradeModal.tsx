// DEPRECATED: Replaced by OrderModal.tsx. This component is no longer rendered
// in the live UI. The payout calculation on line 52 is known to be incorrect
// (shows net profit, not total payout). Do not use.
"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradeModalProps {
  open: boolean;
  onClose: () => void;
  ticker: string;
  strike: number;
  currentPrice?: number;
  /** Pre-selected side */
  side?: "YES" | "NO";
  /** Price in cents (e.g. 65 = 65¢) */
  price?: number;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function TradeModal({
  open,
  onClose,
  ticker,
  strike,
  currentPrice,
  side: initialSide = "YES",
  price: initialPrice,
}: TradeModalProps) {
  const router = useRouter();
  const { connected, publicKey } = useWallet();
  const { setVisible: setWalletVisible } = useWalletModal();
  const [side, setSide] = useState(initialSide);
  const [quantity, setQuantity] = useState(10);

  // Reset side when props change
  useEffect(() => {
    setSide(initialSide);
  }, [initialSide]);

  const unitPrice = side === "YES"
    ? (initialPrice ?? 50)
    : (100 - (initialPrice ?? 50));
  const totalCost = ((quantity * unitPrice) / 100).toFixed(2);
  const potentialWin = ((quantity * (100 - unitPrice)) / 100).toFixed(2);

  const handleTrade = useCallback(() => {
    if (!connected) {
      setWalletVisible(true);
      return;
    }
    router.push(`/trade/${ticker}?side=${side.toLowerCase()}&price=${unitPrice}&qty=${quantity}`);
    onClose();
  }, [connected, setWalletVisible, onClose, router, ticker, side, unitPrice, quantity]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Trade ${ticker}`}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Dialog */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md mx-4 bg-[#111] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header gradient bar */}
        <div className="h-1 bg-gradient-to-r from-green-500 via-blue-500 to-purple-500" />

        <div className="p-6">
          {/* Title */}
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-bold text-white">
                {ticker} — ${strike}
              </h2>
              {currentPrice && (
                <p className="text-xs text-white/40">
                  Yes price: {Math.round(currentPrice * 100)}¢
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-white/30 hover:text-white/60 transition-colors text-xl leading-none"
            >
              &times;
            </button>
          </div>

          {/* Side selector */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            <button
              onClick={() => setSide("YES")}
              className={`rounded-lg py-3 text-center font-bold transition-all ${
                side === "YES"
                  ? "bg-green-500/20 border-2 border-green-500/50 text-green-400 shadow-[0_0_20px_-5px_rgba(34,197,94,0.3)]"
                  : "bg-white/5 border border-white/10 text-white/40 hover:text-white/60"
              }`}
            >
              <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">
                Yes — Above
              </div>
              <div className="text-xl">{initialPrice ?? 50}¢</div>
            </button>
            <button
              onClick={() => setSide("NO")}
              className={`rounded-lg py-3 text-center font-bold transition-all ${
                side === "NO"
                  ? "bg-red-500/20 border-2 border-red-500/50 text-red-400 shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]"
                  : "bg-white/5 border border-white/10 text-white/40 hover:text-white/60"
              }`}
            >
              <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">
                No — Below
              </div>
              <div className="text-xl">{100 - (initialPrice ?? 50)}¢</div>
            </button>
          </div>

          {/* Quantity */}
          <div className="mb-5">
            <label className="text-xs text-white/40 uppercase tracking-wider block mb-2">
              Quantity (contracts)
            </label>
            <div className="flex items-center gap-2">
              {[1, 5, 10, 25, 50, 100].map((q) => (
                <button
                  key={q}
                  onClick={() => setQuantity(q)}
                  className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-all ${
                    quantity === q
                      ? "bg-white/15 text-white border border-white/20"
                      : "bg-white/5 text-white/40 border border-white/5 hover:text-white/60"
                  }`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Cost summary */}
          <div className="rounded-lg bg-white/5 border border-white/10 p-4 mb-5">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-white/50">Cost</span>
              <span className="text-white font-bold tabular-nums">
                ${totalCost} USDC
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/50">Potential win</span>
              <span className="text-green-400 font-bold tabular-nums">
                +${potentialWin} USDC
              </span>
            </div>
            <div className="border-t border-white/10 mt-2 pt-2 flex items-center justify-between text-xs text-white/30">
              <span>Settles at 4:00 PM ET</span>
              <span>
                {quantity} × {unitPrice}¢ = ${totalCost}
              </span>
            </div>
            <p className="text-[10px] text-white/20 text-center mt-1">
              Price may change before execution
            </p>
          </div>

          {/* Action button */}
          {connected ? (
            <>
              <button
                onClick={handleTrade}
                className={`w-full rounded-xl py-3 font-bold text-white transition-all ${
                  side === "YES"
                    ? "bg-gradient-to-r from-green-600 to-green-500 hover:from-green-500 hover:to-green-400 shadow-lg shadow-green-500/20"
                    : "bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 shadow-lg shadow-red-500/20"
                }`}
              >
                Trade {ticker} {side} &rarr;
              </button>
              <p className="text-[10px] text-white/30 text-center mt-1">
                Opens trading page
              </p>
            </>
          ) : (
            <button
              onClick={() => setWalletVisible(true)}
              className="w-full rounded-xl py-3 font-bold text-white bg-gradient-to-r from-green-500 via-blue-500 to-purple-500 hover:from-green-400 hover:via-blue-400 hover:to-purple-400 transition-all shadow-lg shadow-blue-500/20"
            >
              Connect Wallet to Trade
            </button>
          )}

          {/* Wallet address if connected */}
          {connected && publicKey && (
            <p className="text-[10px] text-white/20 text-center mt-2 tabular-nums">
              {publicKey.toBase58().slice(0, 8)}...{publicKey.toBase58().slice(-6)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
