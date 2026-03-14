"use client";

import { useState, useCallback, useMemo } from "react";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import {
  findGlobalConfig,
  findTreasury,
  findOrderBook,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
} from "@/lib/pda";
import { CreateMarketForm } from "../CreateMarketForm";

// ---------------------------------------------------------------------------
// MarketRow — extended version of MarketActionRow with close/cleanup/crank
// ---------------------------------------------------------------------------

function MarketRow({ market }: { market: ParsedMarket }) {
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
  const canClose = market.isSettled && now > overrideDeadline;
  const canCrankCancel = market.isSettled;
  const canCrankRedeem = market.isSettled;
  const canCleanup = market.isClosed;

  const handleAction = useCallback(async (action: string, buildTx: () => Promise<any>) => {
    if (!program || !publicKey) return;
    setSubmitting(action);
    try {
      const tx = await buildTx();
      if (tx) {
        await sendTransaction(tx, { description: `${action} ${market.ticker}` });
        queryClient.invalidateQueries({ queryKey: ["markets"] });
      }
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, market.ticker, sendTransaction, queryClient]);

  const [configAddr] = findGlobalConfig();

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      {/* Header */}
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
          {market.isClosed && (
            <span className="text-[10px] text-white/40 bg-white/10 px-1.5 py-0.5 rounded">CLOSED</span>
          )}
        </div>
        <div className="flex gap-2">
          {!market.isPaused ? (
            <button
              onClick={() => handleAction("Pause", () =>
                program!.methods.pause(market.publicKey)
                  .accountsPartial({ admin: publicKey!, config: configAddr, market: market.publicKey })
                  .transaction()
              )}
              disabled={submitting !== null}
              className="text-[11px] text-yellow-400/70 hover:text-yellow-400 transition-colors"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={() => handleAction("Unpause", () =>
                program!.methods.unpause(market.publicKey)
                  .accountsPartial({ admin: publicKey!, config: configAddr, market: market.publicKey })
                  .transaction()
              )}
              disabled={submitting !== null}
              className="text-[11px] text-green-400/70 hover:text-green-400 transition-colors"
            >
              Unpause
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {canSettle && (
          <button
            onClick={() => handleAction("Settle", () =>
              program!.methods.settleMarket()
                .accountsPartial({ caller: publicKey!, config: configAddr, market: market.publicKey, oracleFeed: market.oracleFeed })
                .transaction()
            )}
            disabled={submitting !== null}
            className="text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            {submitting === "Settle" ? "..." : "Settle (Oracle)"}
          </button>
        )}

        {canAdminSettle && (
          <div className="flex items-center gap-1">
            <input
              type="number" step="0.01" value={settlePriceInput}
              onChange={(e) => setSettlePriceInput(e.target.value)}
              placeholder="$price"
              className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white focus:outline-none"
            />
            <button
              onClick={() => {
                const p = parseFloat(settlePriceInput);
                if (isNaN(p) || p <= 0) return;
                handleAction("Admin Settle", () =>
                  program!.methods.adminSettle(new BN(Math.round(p * 1_000_000)))
                    .accountsPartial({ admin: publicKey!, config: configAddr, market: market.publicKey })
                    .transaction()
                );
              }}
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
              type="number" step="0.01" value={overridePriceInput}
              onChange={(e) => setOverridePriceInput(e.target.value)}
              placeholder="$new price"
              className="w-24 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white focus:outline-none"
            />
            <button
              onClick={() => {
                const p = parseFloat(overridePriceInput);
                if (isNaN(p) || p <= 0) return;
                handleAction("Override", () =>
                  program!.methods.adminOverrideSettlement(new BN(Math.round(p * 1_000_000)))
                    .accountsPartial({ admin: publicKey!, config: configAddr, market: market.publicKey })
                    .transaction()
                );
              }}
              disabled={submitting !== null || !overridePriceInput}
              className="text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-md px-2 py-1.5 transition-colors disabled:opacity-50"
            >
              Override ({market.overrideCount}/3)
            </button>
          </div>
        )}

        {canCrankCancel && (
          <button
            onClick={() => handleAction("Crank Cancel", () => {
              const [orderBook] = findOrderBook(market.publicKey);
              const [escrowVault] = findEscrowVault(market.publicKey);
              const [yesEscrow] = findYesEscrow(market.publicKey);
              const [noEscrow] = findNoEscrow(market.publicKey);
              return program!.methods.crankCancel(10)
                .accountsPartial({
                  caller: publicKey!, config: configAddr, market: market.publicKey,
                  orderBook, escrowVault, yesEscrow, noEscrow,
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
                .transaction();
            })}
            disabled={submitting !== null}
            className="text-xs bg-white/5 text-white/50 hover:text-white/80 border border-white/10 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            Crank Cancel
          </button>
        )}

        {canCrankRedeem && (
          <button
            onClick={() => handleAction("Crank Redeem", () => {
              const [yesMint] = findYesMint(market.publicKey);
              const [noMint] = findNoMint(market.publicKey);
              const [usdcVault] = findUsdcVault(market.publicKey);
              return program!.methods.crankRedeem(10)
                .accountsPartial({
                  caller: publicKey!, config: configAddr, market: market.publicKey,
                  yesMint, noMint, usdcVault,
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
                .transaction();
            })}
            disabled={submitting !== null}
            className="text-xs bg-white/5 text-white/50 hover:text-white/80 border border-white/10 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            Crank Redeem
          </button>
        )}

        {canClose && (
          <button
            onClick={() => handleAction("Close Market", () => {
              const [orderBook] = findOrderBook(market.publicKey);
              const [usdcVault] = findUsdcVault(market.publicKey);
              const [escrowVault] = findEscrowVault(market.publicKey);
              const [yesEscrow] = findYesEscrow(market.publicKey);
              const [noEscrow] = findNoEscrow(market.publicKey);
              const [yesMint] = findYesMint(market.publicKey);
              const [noMint] = findNoMint(market.publicKey);
              const [treasury] = findTreasury();
              return program!.methods.closeMarket()
                .accountsPartial({
                  admin: publicKey!, config: configAddr, market: market.publicKey,
                  orderBook, usdcVault, escrowVault, yesEscrow, noEscrow,
                  yesMint, noMint, treasury,
                  tokenProgram: TOKEN_PROGRAM_ID,
                  systemProgram: SystemProgram.programId,
                })
                .transaction();
            })}
            disabled={submitting !== null}
            className="text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            Close Market
          </button>
        )}

        {canCleanup && (
          <button
            onClick={() => handleAction("Cleanup", () => {
              const [yesMint] = findYesMint(market.publicKey);
              const [noMint] = findNoMint(market.publicKey);
              return program!.methods.cleanupMarket()
                .accountsPartial({
                  admin: publicKey!, config: configAddr, market: market.publicKey,
                  yesMint, noMint,
                })
                .transaction();
            })}
            disabled={submitting !== null}
            className="text-xs bg-red-500/10 text-red-400/70 hover:text-red-400 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            Cleanup
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketsPanel
// ---------------------------------------------------------------------------

export function MarketsPanel() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const { data: markets = [] } = useMarkets();
  const [confirmingBreaker, setConfirmingBreaker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const grouped = useMemo(() => {
    const active: ParsedMarket[] = [];
    const paused: ParsedMarket[] = [];
    const settled: ParsedMarket[] = [];
    const closed: ParsedMarket[] = [];

    for (const m of markets) {
      if (m.isClosed) closed.push(m);
      else if (m.isSettled) settled.push(m);
      else if (m.isPaused) paused.push(m);
      else active.push(m);
    }

    const byTicker = (a: ParsedMarket, b: ParsedMarket) => a.ticker.localeCompare(b.ticker);
    return {
      active: active.sort(byTicker),
      paused: paused.sort(byTicker),
      settled: settled.sort(byTicker),
      closed: closed.sort(byTicker),
    };
  }, [markets]);

  const handleCircuitBreaker = useCallback(async () => {
    if (!program || !publicKey) return;
    setSubmitting(true);

    try {
      const [configAddr] = findGlobalConfig();
      const activeMarkets = markets.filter((m) => !m.isSettled && !m.isClosed);
      const remainingAccounts = activeMarkets.flatMap((m) => {
        const [orderBook] = findOrderBook(m.publicKey);
        return [
          { pubkey: m.publicKey, isWritable: true, isSigner: false },
          { pubkey: orderBook, isWritable: true, isSigner: false },
        ];
      });

      const tx = await program.methods
        .circuitBreaker()
        .accountsPartial({ admin: publicKey, config: configAddr })
        .remainingAccounts(remainingAccounts)
        .transaction();

      await sendTransaction(tx, { description: "Circuit Breaker" });
      queryClient.invalidateQueries({ queryKey: ["markets"] });
      queryClient.invalidateQueries({ queryKey: ["global-config"] });
      setConfirmingBreaker(false);
    } catch { /* handled by toast */ }
    finally { setSubmitting(false); }
  }, [program, publicKey, markets, sendTransaction, queryClient]);

  return (
    <div className="space-y-4">
      {/* Circuit Breaker + Create Market */}
      <div className="flex flex-wrap gap-3">
        {!confirmingBreaker ? (
          <button
            onClick={() => setConfirmingBreaker(true)}
            className="rounded-md px-4 py-2 text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          >
            Circuit Breaker
          </button>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2">
            <span className="text-xs text-red-400">Pause all markets and cancel all orders?</span>
            <button
              onClick={handleCircuitBreaker}
              disabled={submitting}
              className="text-xs font-semibold text-red-400 bg-red-500/20 hover:bg-red-500/30 rounded px-3 py-1 transition-colors"
            >
              {submitting ? "..." : "Confirm"}
            </button>
            <button
              onClick={() => setConfirmingBreaker(false)}
              className="text-xs text-white/40 hover:text-white/60 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Create Market */}
      <CreateMarketForm />

      {/* Market groups */}
      {grouped.active.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-white/80">Active ({grouped.active.length})</h3>
          {grouped.active.map((m) => <MarketRow key={m.publicKey.toBase58()} market={m} />)}
        </div>
      )}

      {grouped.paused.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-yellow-400/80">Paused ({grouped.paused.length})</h3>
          {grouped.paused.map((m) => <MarketRow key={m.publicKey.toBase58()} market={m} />)}
        </div>
      )}

      {grouped.settled.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-accent/80">Settled ({grouped.settled.length})</h3>
          {grouped.settled.map((m) => <MarketRow key={m.publicKey.toBase58()} market={m} />)}
        </div>
      )}

      {grouped.closed.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-white/40">Closed ({grouped.closed.length})</h3>
          {grouped.closed.map((m) => <MarketRow key={m.publicKey.toBase58()} market={m} />)}
        </div>
      )}

      {markets.length === 0 && (
        <p className="text-white/40 text-xs">No markets found.</p>
      )}
    </div>
  );
}
