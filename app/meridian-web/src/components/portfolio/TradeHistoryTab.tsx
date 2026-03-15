"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useIndexedEvents } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";
import { buildCsv, downloadCsv } from "@/lib/csv";
import { getExplorerUrl } from "@/lib/network";
import { SIDE_LABELS } from "@/lib/constants";

/**
 * Derive viewer-perspective intent label when no stored intent is available.
 *
 * On-chain sides: 0 = USDC bid (Buy Yes), 1 = Yes ask (Sell Yes), 2 = No-backed bid (Sell No).
 *
 * Taker labels map directly from takerSide.
 * Maker labels must use makerSide because a Sell-Yes taker (side 1) can match
 * against either a USDC-bid maker (side 0 → Buy Yes) or a No-backed-bid maker
 * (side 2 → Sell No).
 */
function deriveViewerIntent(takerSide: number, makerSide: number, isTaker: boolean): string {
  if (isTaker) {
    return SIDE_LABELS[takerSide] ?? "Unknown";
  }
  // Maker label is determined by the maker's own resting side
  return SIDE_LABELS[makerSide] ?? "Unknown";
}

const INTENT_COLORS: Record<string, string> = {
  "Buy Yes": "text-green-400",
  "Sell Yes": "text-amber-400",
  "Sell No": "text-red-400",
};

export function TradeHistoryTab() {
  const { publicKey } = useWallet();
  const { data: events = [], isLoading } = useIndexedEvents({ type: "fill", limit: 500 });

  const fills = useMemo(() => {
    if (!publicKey) return [];
    const walletStr = publicKey.toBase58();
    return events
      .map((e) => {
        const parsed = parseFillEvent(e);
        if (!parsed) return null;
        return { ...parsed, signature: e.signature };
      })
      .filter((f): f is NonNullable<typeof f> => {
        if (!f) return false;
        return f.maker === walletStr || f.taker === walletStr;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events, publicKey]);

  const handleExport = () => {
    const headers = ["Date", "Side", "Price (c)", "Quantity", "Role", "Tx Signature"];
    const walletStr = publicKey?.toBase58() ?? "";
    const rows = fills.map((f) => {
      const isTaker = f.taker === walletStr;
      const role = isTaker ? "Taker" : "Maker";
      const sideLabel = deriveViewerIntent(f.takerSide, f.makerSide, isTaker);
      return [
        new Date(f.timestamp * 1000).toISOString(),
        sideLabel,
        String(f.price),
        String(f.quantity / 1_000_000),
        role,
        f.signature ?? "",
      ];
    });
    const csv = buildCsv(headers, rows);
    downloadCsv(csv, `meridian-history-${new Date().toISOString().split("T")[0]}.csv`);
  };

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-white/5 border border-white/10 animate-pulse" />;
  }

  if (fills.length === 0) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
        <p className="text-white/50 text-sm mb-1">No trade history</p>
        <p className="text-white/30 text-xs">Your executed trades will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-white/50">{fills.length} trade{fills.length !== 1 ? "s" : ""}</span>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-white/10 hover:bg-white/15 transition-colors border border-white/20 rounded-lg px-4 py-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M8 1a.75.75 0 0 1 .75.75v6.44l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V1.75A.75.75 0 0 1 8 1ZM2.75 11a.75.75 0 0 1 .75.75v1.5h9v-1.5a.75.75 0 0 1 1.5 0v1.5A1.5 1.5 0 0 1 12.5 14.75h-9A1.5 1.5 0 0 1 2 13.25v-1.5a.75.75 0 0 1 .75-.75Z" />
          </svg>
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-white/40 text-left border-b border-white/10">
              <th className="py-2 px-2 font-medium">Date</th>
              <th className="py-2 px-2 font-medium">Side</th>
              <th className="py-2 px-2 font-medium text-right">Price</th>
              <th className="py-2 px-2 font-medium text-right">Qty</th>
              <th className="py-2 px-2 font-medium">Role</th>
              <th className="py-2 px-2 font-medium">Tx</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f, i) => {
              const isTaker = f.taker === publicKey?.toBase58();
              const sideLabel = deriveViewerIntent(f.takerSide, f.makerSide, isTaker);
              const sideColor = INTENT_COLORS[sideLabel] ?? "text-white/50";
              const role = isTaker ? "Taker" : "Maker";
              const qty = (f.quantity / 1_000_000).toFixed(0);

              return (
                <tr key={`${f.signature}-${i}`} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 px-2 text-white/50">
                    {new Date(f.timestamp * 1000).toLocaleString()}
                  </td>
                  <td className={`py-2 px-2 font-medium ${sideColor}`}>{sideLabel}</td>
                  <td className="py-2 px-2 text-right text-white/70 tabular-nums">{f.price}c</td>
                  <td className="py-2 px-2 text-right text-white/70 tabular-nums">{qty}</td>
                  <td className="py-2 px-2 text-white/40">{role}</td>
                  <td className="py-2 px-2">
                    {f.signature && (
                      <a
                        href={getExplorerUrl(f.signature)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:text-accent/80 transition-colors"
                      >
                        {f.signature.slice(0, 8)}...
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
