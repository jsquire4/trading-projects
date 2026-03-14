"use client";

import { useState, useCallback } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useTickerRegistry } from "@/hooks/useTickerRegistry";
import { findGlobalConfig, findTickerRegistry, padTicker } from "@/lib/pda";

export function TickerManagement() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const { data: config } = useGlobalConfig();
  const { data: tickers = [] } = useTickerRegistry();

  const [newTicker, setNewTicker] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);

  const isAdmin = publicKey && config?.admin.equals(publicKey);
  const [configAddr] = findGlobalConfig();
  const [registryAddr] = findTickerRegistry();

  const handleAddTicker = useCallback(async () => {
    if (!program || !publicKey || !newTicker.trim()) return;
    const ticker = newTicker.trim().toUpperCase();
    if (ticker.length > 8) return;

    setSubmitting("add");
    try {
      const tickerBytes = Array.from(padTicker(ticker));
      const tx = await program.methods
        .addTicker(tickerBytes)
        .accountsPartial({
          payer: publicKey,
          config: configAddr,
          tickerRegistry: registryAddr,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      await sendTransaction(tx, { description: `Add Ticker: ${ticker}` });
      queryClient.invalidateQueries({ queryKey: ["ticker-registry"] });
      setNewTicker("");
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, newTicker, configAddr, registryAddr, sendTransaction, queryClient]);

  const handleDeactivate = useCallback(async (ticker: string) => {
    if (!program || !publicKey) return;

    setSubmitting(`deactivate-${ticker}`);
    try {
      const tickerBytes = Array.from(padTicker(ticker));
      const tx = await program.methods
        .deactivateTicker(tickerBytes)
        .accountsPartial({
          admin: publicKey,
          config: configAddr,
          tickerRegistry: registryAddr,
        })
        .transaction();
      await sendTransaction(tx, { description: `Deactivate: ${ticker}` });
      queryClient.invalidateQueries({ queryKey: ["ticker-registry"] });
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, configAddr, registryAddr, sendTransaction, queryClient]);

  const activeTickers = tickers.filter((t) => t.isActive);
  const inactiveTickers = tickers.filter((t) => !t.isActive);

  return (
    <div className="space-y-4">
      {/* Add Ticker */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white/80">Add Ticker</h3>
        <p className="text-xs text-white/40">
          Anyone can add a ticker (permissionless). The payer covers rent for the registry entry.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            maxLength={8}
            value={newTicker}
            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
            className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none font-mono uppercase"
          />
          <button
            onClick={handleAddTicker}
            disabled={submitting !== null || !newTicker.trim()}
            className="rounded-md px-4 py-2 text-sm font-medium bg-accent/20 text-accent hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
          >
            {submitting === "add" ? "..." : "Add"}
          </button>
        </div>
      </div>

      {/* Active Tickers */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white/80">
          Active Tickers ({activeTickers.length})
        </h3>

        {activeTickers.length === 0 ? (
          <p className="text-white/40 text-xs">No tickers registered yet.</p>
        ) : (
          <div className="space-y-1">
            {activeTickers.map((entry) => (
              <div
                key={entry.ticker}
                className="flex items-center justify-between py-2 px-3 rounded-md bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-white font-mono font-medium text-sm">{entry.ticker}</span>
                  <span className="text-xs text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded">ACTIVE</span>
                  {!entry.pythFeed.equals(PublicKey.default) && (
                    <span className="text-[10px] text-white/20 font-mono truncate max-w-[120px]">
                      Pyth: {entry.pythFeed.toBase58().slice(0, 8)}...
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <button
                    onClick={() => handleDeactivate(entry.ticker)}
                    disabled={submitting !== null}
                    className="text-[11px] text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    {submitting === `deactivate-${entry.ticker}` ? "..." : "Deactivate"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deactivated Tickers */}
      {inactiveTickers.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white/40">
            Deactivated ({inactiveTickers.length})
          </h3>
          <div className="space-y-1">
            {inactiveTickers.map((entry) => (
              <div
                key={entry.ticker}
                className="flex items-center gap-3 py-2 px-3 rounded-md opacity-50"
              >
                <span className="text-white/40 font-mono text-sm">{entry.ticker}</span>
                <span className="text-[10px] text-white/20 bg-white/5 px-1.5 py-0.5 rounded">DEACTIVATED</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
