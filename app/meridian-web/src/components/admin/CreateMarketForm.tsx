"use client";

import { useState, useCallback } from "react";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useTickerRegistry } from "@/hooks/useTickerRegistry";
import { USDC_MINT } from "@/hooks/useWalletState";
import {
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
  findGlobalConfig,
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findPriceFeed,
  padTicker,
} from "@/lib/pda";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

type CreateStep = "idle" | "creating" | "alt-create" | "alt-extend" | "alt-set" | "done";

const STEP_LABELS: Record<CreateStep, string> = {
  idle: "Create Strike Market",
  creating: "1/4 Creating market...",
  "alt-create": "2/4 Creating lookup table...",
  "alt-extend": "3/4 Extending lookup table...",
  "alt-set": "4/4 Setting market ALT...",
  done: "Done!",
};

export function CreateMarketForm() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const { data: registeredTickers = [] } = useTickerRegistry();

  const activeTickers = registeredTickers
    .filter((t) => t.isActive)
    .map((t) => t.ticker)
    .sort();

  const [ticker, setTicker] = useState("");
  const [strikePrice, setStrikePrice] = useState("");
  const [closeTime, setCloseTime] = useState("");
  const [previousClose, setPreviousClose] = useState("");
  const [step, setStep] = useState<CreateStep>("idle");
  const [error, setError] = useState<string | null>(null);

  // Auto-select first ticker when registry loads
  if (!ticker && activeTickers.length > 0) {
    setTicker(activeTickers[0]);
  }

  const submitting = step !== "idle";

  const handleCreate = useCallback(async () => {
    if (!program || !publicKey || !strikePrice || !closeTime || !previousClose || !ticker) return;
    setError(null);

    const strikeParsed = parseFloat(strikePrice);
    const prevCloseParsed = parseFloat(previousClose);
    const closeMs = new Date(closeTime).getTime();
    if (isNaN(strikeParsed) || strikeParsed <= 0) { setError("Strike price must be a positive number."); return; }
    if (isNaN(prevCloseParsed) || prevCloseParsed <= 0) { setError("Previous close must be a positive number."); return; }
    if (isNaN(closeMs) || closeMs <= Date.now()) { setError("Close time must be in the future."); return; }

    try {
      const strikeLamports = BigInt(Math.round(strikeParsed * 1_000_000));
      const closeUnix = Math.floor(closeMs / 1000);
      const prevCloseLamports = BigInt(Math.round(prevCloseParsed * 1_000_000));
      const expiryDay = Math.floor(closeUnix / 86400);

      const tickerBytes = Array.from(padTicker(ticker));
      const [config] = findGlobalConfig();
      const [market] = findStrikeMarket(ticker, strikeLamports, closeUnix);
      const [yesMint] = findYesMint(market);
      const [noMint] = findNoMint(market);
      const [usdcVault] = findUsdcVault(market);
      const [escrowVault] = findEscrowVault(market);
      const [yesEscrow] = findYesEscrow(market);
      const [noEscrow] = findNoEscrow(market);
      const [orderBook] = findOrderBook(market);
      const [oracleFeed] = findPriceFeed(ticker);

      // Step 1: Create the strike market
      setStep("creating");
      const createTx = await program.methods
        .createStrikeMarket(
          tickerBytes,
          new BN(strikeLamports.toString()),
          expiryDay,
          new BN(closeUnix),
          new BN(prevCloseLamports.toString()),
        )
        .accountsPartial({
          creator: publicKey,
          config,
          market,
          yesMint,
          noMint,
          usdcVault,
          escrowVault,
          yesEscrow,
          noEscrow,
          orderBook,
          oracleFeed,
          usdcMint: USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .transaction();

      await sendTransaction(createTx, { description: `Create ${ticker} $${strikeParsed} market` });

      // Step 2: Create Address Lookup Table
      setStep("alt-create");
      const slot = await connection.getSlot("confirmed");
      const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: publicKey,
        payer: publicKey,
        recentSlot: slot,
      });
      const altCreateTx = new Transaction().add(createAltIx);
      await sendTransaction(altCreateTx, { description: "Create lookup table" });

      // Step 3: Extend ALT with all market accounts
      setStep("alt-extend");
      const addressesToAdd = [
        config, market, yesMint, noMint,
        usdcVault, escrowVault, yesEscrow, noEscrow,
        orderBook, oracleFeed, USDC_MINT,
        MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId, SYSVAR_RENT_PUBKEY,
      ];
      const extendTx = new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          payer: publicKey,
          authority: publicKey,
          lookupTable: altAddress,
          addresses: addressesToAdd,
        }),
      );
      await sendTransaction(extendTx, { description: "Extend lookup table" });

      // Brief pause for ALT to propagate
      await new Promise((r) => setTimeout(r, 500));

      // Step 4: Set the ALT on the market account
      setStep("alt-set");
      const setAltTx = await program.methods
        .setMarketAlt(altAddress)
        .accountsPartial({
          admin: publicKey,
          config,
          market,
        })
        .transaction();
      await sendTransaction(setAltTx, { description: `Set ALT for ${ticker} $${strikeParsed}` });

      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["markets"] });

      // Reset form after brief success indicator
      setTimeout(() => {
        setStrikePrice("");
        setCloseTime("");
        setPreviousClose("");
        setStep("idle");
      }, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setError(`Failed at step "${STEP_LABELS[step]}": ${msg}`);
      setStep("idle");
    }
  }, [program, publicKey, connection, ticker, strikePrice, closeTime, previousClose, step, sendTransaction, queryClient]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white/80">Create Market</h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-white/40 mb-1">Ticker</label>
          {activeTickers.length > 0 ? (
            <select
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
            >
              {activeTickers.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <div className="text-xs text-white/40 py-2">
              No active tickers. Add one in the Tickers tab first.
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs text-white/40 mb-1">Strike Price ($)</label>
          <input
            type="number"
            step="0.01"
            value={strikePrice}
            onChange={(e) => setStrikePrice(e.target.value)}
            placeholder="195.00"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-white/40 mb-1">Close Time</label>
          <input
            type="datetime-local"
            value={closeTime}
            onChange={(e) => setCloseTime(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-white/40 mb-1">Previous Close ($)</label>
          <input
            type="number"
            step="0.01"
            value={previousClose}
            onChange={(e) => setPreviousClose(e.target.value)}
            placeholder="194.50"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Progress indicator */}
      {submitting && step !== "done" && (
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300 rounded-full"
              style={{
                width:
                  step === "creating" ? "25%" :
                  step === "alt-create" ? "50%" :
                  step === "alt-extend" ? "75%" :
                  step === "alt-set" ? "90%" : "0%",
              }}
            />
          </div>
          <span className="text-[10px] text-white/40 shrink-0">{STEP_LABELS[step]}</span>
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={submitting || !strikePrice || !closeTime || !previousClose || !ticker}
        className={`w-full rounded-md py-2.5 text-sm font-semibold text-white transition-colors ${
          step === "done"
            ? "bg-green-500/20 text-green-400"
            : "bg-accent/20 hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20"
        }`}
      >
        {STEP_LABELS[step]}
      </button>
    </div>
  );
}
