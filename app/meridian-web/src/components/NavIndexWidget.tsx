"use client";

import Link from "next/link";
import { useMeridianIndex } from "@/hooks/useSignals";

export function NavIndexWidget() {
  const { data, isLoading, isError } = useMeridianIndex();

  // Show skeleton while loading, hide on persistent error
  if (isLoading) {
    return (
      <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-xs shrink-0">
        <span className="text-white/40">MI</span>
        <span className="text-white/20 font-mono">&mdash;</span>
      </div>
    );
  }

  if (isError || !data) return null;

  const index = data.value;
  const color = index > 60 ? "text-green-400" : index < 40 ? "text-red-400" : "text-amber-400";
  const trend = index > 60 ? "trending up" : index < 40 ? "trending down" : "neutral";
  const arrow = index > 60 ? "\u25B2" : index < 40 ? "\u25BC" : "\u2014";

  return (
    <Link
      href="/signals"
      aria-label={`Meridian Index: ${index.toFixed(0)}, ${trend} — view signals`}
      className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-xs shrink-0 hover:bg-white/10 transition-colors"
    >
      <span className="text-white/40">MI</span>
      <span className={`font-mono font-medium ${color}`}>
        {index.toFixed(0)}
      </span>
      <span className={`text-[10px] ${color}`}>{arrow}</span>
    </Link>
  );
}
