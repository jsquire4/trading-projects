"use client";

/**
 * OptionsChainTable — Real options chain from Tradier displayed as a readable table.
 * Shows calls and puts near ATM with expiration selector.
 */

import { useMemo } from "react";
import { useTradierOptions, useTradierQuotes, useTradierExpirations } from "@/hooks/useAnalyticsData";

interface OptionsChainTableProps {
  ticker: string;
  selectedExpiration: string | null;
  onExpirationChange: (exp: string) => void;
}

function formatExpLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const target = new Date(dateStr + "T12:00:00");
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);

  const label = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  if (diffDays === 0) return `${label} (0DTE)`;
  if (diffDays === 1) return `${label} (1d)`;
  if (diffDays <= 7) return `${label} (${diffDays}d)`;
  return label;
}

export function OptionsChainTable({
  ticker,
  selectedExpiration,
  onExpirationChange,
}: OptionsChainTableProps) {
  const { data: expirations } = useTradierExpirations(ticker);
  const { data: optionsResult, isLoading } = useTradierOptions(ticker, selectedExpiration);
  const { data: quotes } = useTradierQuotes([ticker]);

  const optionsChain = optionsResult?.chain ?? null;
  const activeExpiration = optionsResult?.expiration ?? null;

  const spotPrice = useMemo(() => {
    if (!quotes || quotes.length === 0) return null;
    const q = quotes.find((q) => q.symbol.toUpperCase() === ticker.toUpperCase());
    return q?.last ?? null;
  }, [quotes, ticker]);

  // Show first ~8 expirations
  const visibleExpirations = useMemo(() => {
    if (!expirations) return [];
    const today = new Date().toISOString().split("T")[0];
    return expirations.filter((d) => d >= today).slice(0, 8);
  }, [expirations]);

  const calls = useMemo(() => {
    if (!optionsChain || !spotPrice || spotPrice <= 0) return [];
    const lo = spotPrice * 0.90;
    const hi = spotPrice * 1.10;
    return optionsChain
      .filter(
        (o) =>
          (o.option_type === "call" || o.type === "call") &&
          o.strike >= lo &&
          o.strike <= hi,
      )
      .sort((a, b) => a.strike - b.strike);
  }, [optionsChain, spotPrice]);

  const puts = useMemo(() => {
    if (!optionsChain || !spotPrice || spotPrice <= 0) return [];
    const lo = spotPrice * 0.90;
    const hi = spotPrice * 1.10;
    return optionsChain
      .filter(
        (o) =>
          (o.option_type === "put" || o.type === "put") &&
          o.strike >= lo &&
          o.strike <= hi,
      )
      .sort((a, b) => a.strike - b.strike);
  }, [optionsChain, spotPrice]);

  const atmStrike = useMemo(() => {
    if (!spotPrice || calls.length === 0) return null;
    return calls.reduce((best, c) =>
      Math.abs(c.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? c : best,
    ).strike;
  }, [calls, spotPrice]);

  if (isLoading && !optionsChain) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-5 w-48 rounded bg-white/10" />
        <div className="h-64 rounded bg-white/5" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Expiration selector */}
      {visibleExpirations.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-white/40">Expiration:</span>
          {visibleExpirations.map((exp) => (
            <button
              key={exp}
              onClick={() => onExpirationChange(exp)}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                (selectedExpiration === exp) || (!selectedExpiration && activeExpiration === exp)
                  ? "bg-white/10 text-white font-medium"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              }`}
            >
              {formatExpLabel(exp)}
            </button>
          ))}
        </div>
      )}

      {/* Info bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/40">
          Strikes within &plusmn;10% of spot ({spotPrice ? `$${spotPrice.toFixed(2)}` : ""})
        </p>
        <p className="text-[10px] text-white/25">{calls.length} calls, {puts.length} puts</p>
      </div>

      {calls.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] px-6 py-8 text-center">
          <p className="text-sm text-white/50">No options data available for {ticker}.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full text-xs min-w-[720px]">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03]">
                <th className="px-2 py-2 text-left font-medium text-white/40" colSpan={6}>
                  <span className="text-green-400/70">CALLS</span>
                </th>
                <th className="px-3 py-2 text-center font-medium text-white/60 bg-white/[0.03] border-x border-white/10">
                  Strike
                </th>
                <th className="px-2 py-2 text-right font-medium text-white/40" colSpan={6}>
                  <span className="text-red-400/70">PUTS</span>
                </th>
              </tr>
              <tr className="border-b border-white/10 bg-white/[0.02] text-[10px] uppercase tracking-wider text-white/30">
                <th className="px-2 py-1.5 text-right">Last</th>
                <th className="px-2 py-1.5 text-right">Bid</th>
                <th className="px-2 py-1.5 text-right">Ask</th>
                <th className="px-2 py-1.5 text-right">IV</th>
                <th className="px-2 py-1.5 text-right">Delta</th>
                <th className="px-2 py-1.5 text-right">Vol</th>
                <th className="px-3 py-1.5 text-center bg-white/[0.03] border-x border-white/10"></th>
                <th className="px-2 py-1.5 text-right">Last</th>
                <th className="px-2 py-1.5 text-right">Bid</th>
                <th className="px-2 py-1.5 text-right">Ask</th>
                <th className="px-2 py-1.5 text-right">IV</th>
                <th className="px-2 py-1.5 text-right">Delta</th>
                <th className="px-2 py-1.5 text-right">Vol</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => {
                const put = puts.find((p) => p.strike === call.strike);
                const isATM = call.strike === atmStrike;
                const isITM = spotPrice ? call.strike < spotPrice : false;

                return (
                  <tr
                    key={call.strike}
                    className={`border-b border-white/5 transition-colors hover:bg-white/[0.04] ${
                      isATM ? "bg-white/[0.06]" : isITM ? "bg-green-500/[0.03]" : ""
                    }`}
                  >
                    <td className="px-2 py-1.5 text-right font-mono text-white/70">
                      {call.last != null ? call.last.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-green-400/70">
                      {call.bid > 0 ? call.bid.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-red-400/70">
                      {call.ask > 0 ? call.ask.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/50">
                      {call.greeks?.mid_iv ? `${(call.greeks.mid_iv * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/70">
                      {call.greeks?.delta != null ? call.greeks.delta.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/40">
                      {call.volume > 0 ? call.volume.toLocaleString() : "—"}
                    </td>

                    <td
                      className={`px-3 py-1.5 text-center font-mono font-semibold border-x border-white/10 ${
                        isATM ? "text-white bg-white/[0.06]" : "text-white/70 bg-white/[0.03]"
                      }`}
                    >
                      ${call.strike.toFixed(0)}
                      {isATM && <span className="ml-1 text-[9px] text-white/40">ATM</span>}
                    </td>

                    <td className="px-2 py-1.5 text-right font-mono text-white/70">
                      {put?.last != null ? put.last.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-green-400/70">
                      {put && put.bid > 0 ? put.bid.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-red-400/70">
                      {put && put.ask > 0 ? put.ask.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/50">
                      {put?.greeks?.mid_iv ? `${(put.greeks.mid_iv * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/70">
                      {put?.greeks?.delta != null ? put.greeks.delta.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-white/40">
                      {put && put.volume > 0 ? put.volume.toLocaleString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-white/20">
        Data from Tradier. Call delta approximates probability of finishing above strike.
        {" "}Meridian binary contracts pay $1 if {ticker} closes above the strike at 4 PM ET.
      </p>
    </div>
  );
}
