"use client";

import { useState, useRef, useEffect } from "react";
import { useTickerValidation } from "@/hooks/useTickerValidation";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TickerSearchProps {
  onSelect: (ticker: string) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inline ticker search input with server-side validation.
 * Extracted from analytics/page.tsx and shared with WatchlistStrip's
 * AddTickerInput (they use the same useTickerValidation hook).
 */
export function TickerSearch({ onSelect, onCancel }: TickerSearchProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { status, errorMsg, validate, clearError } = useTickerValidation();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit() {
    const upper = value.trim().toUpperCase();
    if (!upper) return;
    const valid = await validate(upper);
    if (valid) onSelect(upper);
  }

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            if (status === "error") clearError();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
            else if (e.key === "Escape") onCancel();
          }}
          placeholder="TICKER"
          maxLength={10}
          className={`w-24 rounded-full border px-3 py-1 text-xs font-mono uppercase bg-white/5 text-white outline-none transition-all placeholder:text-white/20 ${
            status === "error"
              ? "border-red-500/50 focus:border-red-500/70"
              : "border-white/20 focus:border-blue-500/50"
          }`}
        />
        {status === "loading" && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border border-white/20 border-t-white/60" />
        )}
      </div>
      <button
        onClick={onCancel}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/40 hover:bg-white/20 hover:text-white/70 transition-colors text-xs leading-none"
        aria-label="Cancel"
      >
        ×
      </button>
      {status === "error" && errorMsg && (
        <div className="absolute left-0 -bottom-6 z-10 whitespace-nowrap rounded bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] text-red-400">
          {errorMsg}
        </div>
      )}
    </div>
  );
}
