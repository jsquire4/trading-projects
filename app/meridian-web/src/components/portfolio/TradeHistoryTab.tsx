"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useIndexedEvents } from "@/hooks/useAnalyticsData";
import { parseFillEvent } from "@/lib/eventParsers";
import { buildCsv, downloadCsv } from "@/lib/csv";

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
    const rows = fills.map((f) => [
      new Date(f.timestamp * 1000).toISOString(),
      f.takerSide === 0 ? "Buy Yes" : f.takerSide === 2 ? "Buy No" : "Sell Yes",
      String(f.price),
      String(f.quantity / 1_000_000),
      f.maker === publicKey?.toBase58() ? "Maker" : "Taker",
      f.signature ?? "",
    ]);
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
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          className="text-xs text-accent hover:text-accent/80 transition-colors border border-accent/30 rounded-md px-3 py-1.5"
        >
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
              const sideLabel = f.takerSide === 0 ? "Buy Yes" : f.takerSide === 2 ? "Buy No" : "Sell Yes";
              const sideColor = f.takerSide === 0 ? "text-green-400" : f.takerSide === 2 ? "text-red-400" : "text-amber-400";
              const role = f.maker === publicKey?.toBase58() ? "Maker" : "Taker";
              const qty = (f.quantity / 1_000_000).toFixed(0);

              return (
                <tr key={`${f.orderId}-${i}`} className="border-b border-white/5 hover:bg-white/5">
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
                        href={`https://explorer.solana.com/tx/${f.signature}?cluster=devnet`}
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
