"use client";

import { useState, useCallback, useMemo } from "react";
import { BN } from "@coral-xyz/anchor";
import { Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { findGlobalConfig } from "@/lib/pda";
import type { ParsedMarket } from "@/hooks/useMarkets";

interface MarketActionsProps {
  markets: ParsedMarket[];
}

function MarketActionRow({ market }: { market: ParsedMarket }) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [settlePriceInput, setSettlePriceInput] = useState("");
  const [overridePriceInput, setOverridePriceInput] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);

  const strikeDollars = Number(market.strikePrice) / 1_000_000;
  const now = Math.floor(Date.now() / 1000);
  const closeUnix = Number(market.marketCloseUnix);
  const canSettle = !market.isSettled && now > closeUnix;
  const canAdminSettle = !market.isSettled && now > closeUnix + 3600;
  const overrideDeadline = Number(market.overrideDeadline);
  const canOverride = market.isSettled && now < overrideDeadline && market.overrideCount < 3;

  const buildSettle = useCallback(async (config: ReturnType<typeof findGlobalConfig>[0]) => {
    return program!.methods.settleMarket()
      .accountsPartial({
        caller: publicKey!,
        config,
        market: market.publicKey,
        oracleFeed: market.oracleFeed,
      }).transaction();
  }, [program, publicKey, market]);

  const buildAdminSettle = useCallback(async (config: ReturnType<typeof findGlobalConfig>[0]) => {
    const parsed = parseFloat(settlePriceInput);
    if (isNaN(parsed) || parsed <= 0) return null;
    const price = new BN(Math.round(parsed * 1_000_000));
    return program!.methods.adminSettle(price)
      .accountsPartial({
        admin: publicKey!,
        config,
        market: market.publicKey,
      }).transaction();
  }, [program, publicKey, market, settlePriceInput]);

  const buildOverride = useCallback(async (config: ReturnType<typeof findGlobalConfig>[0]) => {
    const parsed = parseFloat(overridePriceInput);
    if (isNaN(parsed) || parsed <= 0) return null;
    const price = new BN(Math.round(parsed * 1_000_000));
    return program!.methods.adminOverrideSettlement(price)
      .accountsPartial({
        admin: publicKey!,
        config,
        market: market.publicKey,
      }).transaction();
  }, [program, publicKey, market, overridePriceInput]);

  const buildPause = useCallback(async (config: ReturnType<typeof findGlobalConfig>[0]) => {
    return program!.methods.pause(market.publicKey)
      .accountsPartial({
        admin: publicKey!,
        config,
        market: market.publicKey,
      }).transaction();
  }, [program, publicKey, market]);

  const buildUnpause = useCallback(async (config: ReturnType<typeof findGlobalConfig>[0]) => {
    return program!.methods.unpause(market.publicKey)
      .accountsPartial({
        admin: publicKey!,
        config,
        market: market.publicKey,
      }).transaction();
  }, [program, publicKey, market]);

  type ConfigKey = ReturnType<typeof findGlobalConfig>[0];
  const handlers: Record<string, (config: ConfigKey) => Promise<Transaction | null>> = useMemo(
    () => ({
      settle: buildSettle,
      "admin-settle": buildAdminSettle,
      override: buildOverride,
      pause: buildPause,
      unpause: buildUnpause,
    }),
    [buildSettle, buildAdminSettle, buildOverride, buildPause, buildUnpause],
  );

  const handleAction = useCallback(async (action: string) => {
    if (!program || !publicKey) return;
    const handler = handlers[action];
    if (!handler) return;

    setSubmitting(action);
    try {
      const [config] = findGlobalConfig();
      const tx = await handler(config);
      if (tx) {
        await sendTransaction(tx, { description: `${action} ${market.ticker}` });
        queryClient.invalidateQueries({ queryKey: ["markets"] });
      }
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, handlers, market.ticker, sendTransaction, queryClient]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-white font-medium">{market.ticker}</span>
          <span className="text-white/40 font-mono text-sm">${strikeDollars.toFixed(0)}</span>
          {market.isSettled && (
            <span className="text-[10px] text-accent bg-accent/20 px-1.5 py-0.5 rounded">SETTLED</span>
          )}
          {market.isPaused && (
            <span className="text-[10px] text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded">PAUSED</span>
          )}
        </div>
        <div className="flex gap-2">
          {!market.isPaused ? (
            <button
              onClick={() => handleAction("pause")}
              disabled={submitting !== null}
              className="text-[11px] text-yellow-400/70 hover:text-yellow-400 transition-colors"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={() => handleAction("unpause")}
              disabled={submitting !== null}
              className="text-[11px] text-green-400/70 hover:text-green-400 transition-colors"
            >
              Unpause
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {canSettle && (
          <button
            onClick={() => handleAction("settle")}
            disabled={submitting !== null}
            className="text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            {submitting === "settle" ? "..." : "Settle (Oracle)"}
          </button>
        )}

        {canAdminSettle && (
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={settlePriceInput}
              onChange={(e) => setSettlePriceInput(e.target.value)}
              placeholder="$price"
              className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white focus:outline-none"
            />
            <button
              onClick={() => handleAction("admin-settle")}
              disabled={submitting !== null || !settlePriceInput}
              className="text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-md px-2 py-1.5 transition-colors disabled:opacity-50"
            >
              Admin Settle
            </button>
          </div>
        )}

        {canOverride && (
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={overridePriceInput}
              onChange={(e) => setOverridePriceInput(e.target.value)}
              placeholder="$new price"
              className="w-24 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white focus:outline-none"
            />
            <button
              onClick={() => handleAction("override")}
              disabled={submitting !== null || !overridePriceInput}
              className="text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-md px-2 py-1.5 transition-colors disabled:opacity-50"
            >
              Override ({market.overrideCount}/3)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MarketActions({ markets }: MarketActionsProps) {
  const sorted = [...markets].sort((a, b) => {
    if (a.isSettled !== b.isSettled) return a.isSettled ? 1 : -1;
    return a.ticker.localeCompare(b.ticker);
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white/80">Market Actions</h3>
      {sorted.length === 0 ? (
        <p className="text-white/40 text-xs">No markets found.</p>
      ) : (
        sorted.map((m) => (
          <MarketActionRow key={m.publicKey.toBase58()} market={m} />
        ))
      )}
    </div>
  );
}
