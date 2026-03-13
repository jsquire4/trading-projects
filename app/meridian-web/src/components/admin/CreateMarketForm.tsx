"use client";

import { useState, useCallback } from "react";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { USDC_MINT } from "@/hooks/useWalletState";
import {
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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { MAG7, OTHER_ASSETS } from "@/lib/tickers";

export function CreateMarketForm() {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();

  const [ticker, setTicker] = useState("AAPL");
  const [strikePrice, setStrikePrice] = useState("");
  const [closeTime, setCloseTime] = useState("");
  const [previousClose, setPreviousClose] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!program || !publicKey || !strikePrice || !closeTime || !previousClose) return;
    setError(null);

    const strikeParsed = parseFloat(strikePrice);
    const prevCloseParsed = parseFloat(previousClose);
    const closeMs = new Date(closeTime).getTime();
    if (isNaN(strikeParsed) || strikeParsed <= 0) { setError("Strike price must be a positive number."); return; }
    if (isNaN(prevCloseParsed) || prevCloseParsed <= 0) { setError("Previous close must be a positive number."); return; }
    if (isNaN(closeMs) || closeMs <= Date.now()) { setError("Close time must be in the future."); return; }

    setSubmitting(true);

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

      const tx = await program.methods
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

      await sendTransaction(tx, { description: "Create Market" });
      queryClient.invalidateQueries({ queryKey: ["markets"] });

      // Reset form
      setStrikePrice("");
      setCloseTime("");
      setPreviousClose("");
    } catch {
      // Error handled by useTransaction toast
    } finally {
      setSubmitting(false);
    }
  }, [program, publicKey, ticker, strikePrice, closeTime, previousClose, sendTransaction, queryClient]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white/80">Create Market</h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-white/40 mb-1">Ticker</label>
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            <optgroup label="Magnificent 7">
              {MAG7.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </optgroup>
            <optgroup label="Other Assets">
              {OTHER_ASSETS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </optgroup>
          </select>
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

      <button
        onClick={handleCreate}
        disabled={submitting || !strikePrice || !closeTime || !previousClose}
        className="w-full rounded-md py-2.5 text-sm font-semibold text-white bg-accent/20 hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20 transition-colors"
      >
        {submitting ? "Creating..." : "Create Strike Market"}
      </button>
    </div>
  );
}
