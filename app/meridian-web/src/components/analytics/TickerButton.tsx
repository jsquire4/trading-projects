"use client";

interface TickerButtonProps {
  ticker: string;
  quote?: { last: number; change: number; change_percentage: number };
  isSelected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}

export function TickerButton({ ticker, quote, isSelected, onSelect, onRemove }: TickerButtonProps) {
  const tChange = quote?.change ?? 0;
  const tChangePct = quote?.change_percentage ?? 0;
  const tIsPos = tChange >= 0;

  const buttonClass = `flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all shrink-0 ${
    isSelected
      ? tIsPos
        ? "border-green-500/40 bg-green-500/10 ring-1 ring-green-500/20"
        : "border-red-500/40 bg-red-500/10 ring-1 ring-red-500/20"
      : quote
        ? tIsPos
          ? "border-green-500/20 bg-green-500/5 hover:border-green-500/40 hover:bg-green-500/10"
          : "border-red-500/20 bg-red-500/5 hover:border-red-500/40 hover:bg-red-500/10"
        : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
  }`;

  const inner = (
    <button onClick={onSelect} className={buttonClass}>
      <span className={`font-semibold ${isSelected ? "text-white" : "text-white/90"}`}>{ticker}</span>
      {quote && (
        <>
          <span className="tabular-nums text-white/60">${(quote.last ?? 0).toFixed(2)}</span>
          <span className={`tabular-nums font-medium ${tIsPos ? "text-green-400" : "text-red-400"}`}>
            {tIsPos ? "\u25B2" : "\u25BC"}{Math.abs(tChangePct).toFixed(2)}%
          </span>
        </>
      )}
    </button>
  );

  if (!onRemove) return inner;

  return (
    <div className="group relative flex items-center shrink-0">
      {inner}
      <button
        onClick={onRemove}
        className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/40 hover:bg-red-500/30 hover:text-red-400 transition-colors text-[10px] leading-none"
        aria-label={`Remove ${ticker}`}
      >
        &times;
      </button>
    </div>
  );
}
