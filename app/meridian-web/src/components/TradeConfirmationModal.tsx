"use client";

interface TradeConfirmationModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  ticker: string;
  side: string;
  price: number;
  quantity: number;
  estimatedCost: number;
}

export function TradeConfirmationModal({
  isOpen,
  onConfirm,
  onCancel,
  ticker,
  side,
  price,
  quantity,
  estimatedCost,
}: TradeConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal card */}
      <div className="relative z-10 w-full max-w-md rounded-xl border border-white/10 bg-[#0d0d0d] p-6 shadow-2xl space-y-5">
        <h2 className="text-lg font-bold text-white">Confirm Trade</h2>

        {/* Trade summary */}
        <div className="rounded-lg bg-white/5 border border-white/10 p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-white/50">Ticker</span>
            <span className="text-white font-medium">{ticker}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Side</span>
            <span className="text-white font-medium">{side}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Price</span>
            <span className="text-white font-mono">{price}c</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Quantity</span>
            <span className="text-white font-mono">{quantity}</span>
          </div>
          <div className="flex justify-between border-t border-white/10 pt-2">
            <span className="text-white/50">Estimated Cost</span>
            <span className="text-white font-mono font-semibold">
              ${estimatedCost.toFixed(2)} USDC
            </span>
          </div>
        </div>

        {/* Risk warning */}
        <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 px-4 py-3">
          <p className="text-xs text-orange-400 font-medium">
            You are trading on Solana mainnet with real funds. This action
            cannot be undone once confirmed on-chain.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-md border border-white/10 py-2.5 text-sm text-white/60 hover:text-white hover:border-white/20 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-md bg-orange-500 hover:bg-orange-600 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            Confirm Trade
          </button>
        </div>
      </div>
    </div>
  );
}
