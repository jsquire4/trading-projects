"use client";

import { buildXShareUrl, buildLinkedInShareUrl } from "@/lib/share";
import { getExplorerUrl } from "@/lib/network";

interface TransactionReceiptProps {
  signature: string;
  ticker: string;
  side: string;
  price: number;
  quantity: number;
  cost: number;
  onClose: () => void;
}

export function TransactionReceipt({
  signature,
  ticker,
  side,
  price,
  quantity,
  cost,
  onClose,
}: TransactionReceiptProps) {
  const isSell = side.toLowerCase().startsWith("sell");
  // For buys: potential win = quantity * (100-price) / 100 (you pay price, win 100)
  // For sells: expected proceeds = quantity * price / 100 (you receive price)
  const winAmount = isSell
    ? ((quantity * price) / 100).toFixed(2)
    : ((quantity * (100 - price)) / 100).toFixed(2);
  const winLabel = isSell ? "Expected Proceeds" : "Potential Win";
  const xUrl = buildXShareUrl(ticker, side, parseFloat(winAmount));
  const liUrl = buildLinkedInShareUrl(
    `Just placed a ${side} trade on ${ticker} on Meridian!`,
    `https://meridian.app/trade/${ticker}`,
  );

  return (
    <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-xs">
            ✓
          </div>
          <h3 className="text-sm font-semibold text-green-400">Trade Confirmed</h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-white/30 hover:text-white/60 transition-colors text-sm"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-white/40">Side</span>
          <div className={`font-medium ${side.toLowerCase().includes("yes") ? "text-green-400" : "text-red-400"}`}>
            {side}
          </div>
        </div>
        <div>
          <span className="text-white/40">Quantity</span>
          <div className="text-white font-medium">{quantity}</div>
        </div>
        <div>
          <span className="text-white/40">Price</span>
          <div className="text-white font-mono">{price}c</div>
        </div>
        <div>
          <span className="text-white/40">Total Cost</span>
          <div className="text-white font-mono">${cost.toFixed(2)}</div>
        </div>
        <div>
          <span className="text-white/40">{winLabel}</span>
          <div className={`font-mono ${isSell ? "text-white" : "text-green-400"}`}>
            {isSell ? "" : "+"}${winAmount}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <a
          href={getExplorerUrl(signature)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-center text-xs text-accent hover:text-accent/80 transition-colors py-1.5 rounded-md border border-white/10 hover:border-white/20"
        >
          View on Explorer
        </a>
        <a
          href={xUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-md border border-white/10 hover:border-white/20 text-xs text-white/50 hover:text-white/70 transition-colors"
          title="Share on X"
        >
          𝕏
        </a>
        <a
          href={liUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-md border border-white/10 hover:border-white/20 text-xs text-white/50 hover:text-white/70 transition-colors"
          title="Share on LinkedIn"
        >
          in
        </a>
      </div>

      <p className="text-[10px] text-white/20 text-center font-mono truncate">{signature}</p>
    </div>
  );
}
