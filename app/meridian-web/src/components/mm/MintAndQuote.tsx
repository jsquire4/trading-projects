"use client";

import { useState, useCallback } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { USDC_MINT } from "@/hooks/useWalletState";
import {
  findGlobalConfig,
  findOrderBook,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findYesMint,
  findNoMint,
} from "@/lib/pda";
import { useWalletState } from "@/hooks/useWalletState";
import { usePositions } from "@/hooks/usePositions";
import { FaucetButton } from "@/components/FaucetButton";
import type { ParsedMarket } from "@/hooks/useMarkets";

const LAMPORTS_PER_TOKEN = 1_000_000;

interface MintAndQuoteProps {
  market: ParsedMarket;
}

export function MintAndQuote({ market }: MintAndQuoteProps) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();

  const { solBalance, usdcBalance } = useWalletState();
  const { data: positions = [] } = usePositions();

  // Check if user has Yes tokens for this market (needed for ask side of quote)
  const marketKey = market.publicKey.toBase58();
  const position = positions.find((p) => p.market.publicKey.toBase58() === marketKey);
  const yesBalance = position ? Number(position.yesBal) / LAMPORTS_PER_TOKEN : 0;

  const [mintQty, setMintQty] = useState("10");
  const [bidPrice, setBidPrice] = useState("45");
  const [askPrice, setAskPrice] = useState("55");
  const [quoteQty, setQuoteQty] = useState("5");
  const [submitting, setSubmitting] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["positions"] });
    queryClient.invalidateQueries({ queryKey: ["markets"] });
    queryClient.invalidateQueries({ queryKey: ["order-books"] });
  }, [queryClient]);

  const handleMint = useCallback(async () => {
    if (!program || !publicKey) return;
    const qty = parseFloat(mintQty);
    if (isNaN(qty) || qty < 1) return;
    const lamports = Math.round(qty * LAMPORTS_PER_TOKEN);

    setSubmitting("mint");
    try {
      const [config] = findGlobalConfig();
      const [yesMint] = findYesMint(market.publicKey);
      const [noMint] = findNoMint(market.publicKey);
      const [usdcVault] = findUsdcVault(market.publicKey);
      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
      const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

      const tx = await program.methods
        .mintPair(new BN(lamports))
        .accountsPartial({
          user: publicKey,
          config,
          market: market.publicKey,
          yesMint,
          noMint,
          userUsdcAta,
          userYesAta,
          userNoAta,
          usdcVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      await sendTransaction(tx, { description: `Mint ${qty} pairs` });
      invalidate();
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, market, mintQty, sendTransaction, invalidate]);

  const handleQuote = useCallback(async () => {
    if (!program || !publicKey) return;
    const qty = parseFloat(quoteQty);
    const bid = parseInt(bidPrice, 10);
    const ask = parseInt(askPrice, 10);
    if (isNaN(qty) || qty < 1 || isNaN(bid) || isNaN(ask)) return;
    if (bid < 1 || bid > 99 || ask < 1 || ask > 99) return;
    if (bid >= ask) return; // spread must be positive

    const lamports = Math.round(qty * LAMPORTS_PER_TOKEN);

    setSubmitting("quote");
    try {
      const marketPk = market.publicKey;
      const [config] = findGlobalConfig();
      const [orderBook] = findOrderBook(marketPk);
      const [usdcVault] = findUsdcVault(marketPk);
      const [escrowVault] = findEscrowVault(marketPk);
      const [yesEscrow] = findYesEscrow(marketPk);
      const [noEscrow] = findNoEscrow(marketPk);
      const [yesMint] = findYesMint(marketPk);
      const [noMint] = findNoMint(marketPk);
      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
      const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

      const tx = new Transaction();

      // Ensure ATAs exist
      tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userUsdcAta, publicKey, USDC_MINT));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userYesAta, publicKey, yesMint));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userNoAta, publicKey, noMint));

      const accounts = {
        user: publicKey,
        config,
        market: marketPk,
        orderBook,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        yesMint,
        noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      };

      // Bid (side=0, Buy Yes) — resting limit order
      const bidIx = await program.methods
        .placeOrder(0, bid, new BN(lamports), 1, 0) // orderType=1 (limit), maxFills=0 (rest only)
        .accountsPartial(accounts)
        .instruction();
      tx.add(bidIx);

      // Ask (side=1, Sell Yes) — resting limit order
      const askIx = await program.methods
        .placeOrder(1, ask, new BN(lamports), 1, 0) // orderType=1 (limit), maxFills=0 (rest only)
        .accountsPartial(accounts)
        .instruction();
      tx.add(askIx);

      await sendTransaction(tx, { description: `Quote ${bid}c/${ask}c × ${qty}` });
      invalidate();
    } catch { /* handled by toast */ }
    finally { setSubmitting(null); }
  }, [program, publicKey, market, bidPrice, askPrice, quoteQty, sendTransaction, invalidate]);

  if (market.isSettled || market.isPaused) return null;

  const strikeDollars = (Number(market.strikePrice) / 1_000_000).toFixed(0);
  const needsFunds = solBalance === 0 || solBalance === null || !usdcBalance;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-5 space-y-5">
      <div className="flex items-center gap-2">
        <span className="text-white font-bold">{market.ticker}</span>
        <span className="text-white/40 font-mono text-sm">${strikeDollars}</span>
      </div>

      {needsFunds && (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-400 flex-1">
            {solBalance === 0 || solBalance === null
              ? "Wallet has no SOL — you need SOL for transaction fees and USDC to mint pairs."
              : "No USDC balance — you need USDC to mint pairs."}
          </p>
          <FaucetButton className="shrink-0 text-xs bg-blue-500 text-white hover:bg-blue-400 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50" />
        </div>
      )}

      {/* Mint Pairs */}
      <div className="space-y-2">
        <label className="text-xs text-white/50 font-medium">Mint Pairs</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={mintQty}
            onChange={(e) => setMintQty(e.target.value)}
            className="w-24 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
          />
          <span className={`text-xs ${usdcBalance !== null && (parseFloat(mintQty) || 0) > usdcBalance ? "text-red-400" : "text-white/30"}`}>
            tokens (${parseFloat(mintQty) || 0} USDC)
          </span>
          <button
            onClick={handleMint}
            disabled={submitting !== null || !mintQty || parseFloat(mintQty) < 1 || needsFunds}
            className="text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50 ml-auto"
          >
            {submitting === "mint" ? "Minting..." : "Mint"}
          </button>
        </div>
      </div>

      {/* Post Two-Sided Quote */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-white/50 font-medium">Post Two-Sided Quote</label>
          <span className={`text-[10px] font-mono ${yesBalance > 0 ? "text-white/40" : "text-amber-400"}`}>
            {yesBalance > 0 ? `${yesBalance.toFixed(0)} Yes available` : "No Yes tokens — mint pairs first"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] text-white/30 mb-1">Bid (c)</label>
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              value={bidPrice}
              onChange={(e) => setBidPrice(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-green-400 focus:border-green-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] text-white/30 mb-1">Ask (c)</label>
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              value={askPrice}
              onChange={(e) => setAskPrice(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-red-400 focus:border-red-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] text-white/30 mb-1">Size</label>
            <input
              type="number"
              min={1}
              step={1}
              value={quoteQty}
              onChange={(e) => setQuoteQty(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        {parseInt(bidPrice) >= parseInt(askPrice) && bidPrice && askPrice && (
          <p className="text-[10px] text-red-400">Bid must be less than ask (positive spread).</p>
        )}
        {yesBalance > 0 && (parseFloat(quoteQty) || 0) > yesBalance && (
          <p className="text-[10px] text-red-400">Ask size exceeds Yes balance ({yesBalance.toFixed(0)} available). Mint more pairs first.</p>
        )}
        <button
          onClick={handleQuote}
          disabled={
            submitting !== null ||
            !bidPrice || !askPrice || !quoteQty ||
            parseInt(bidPrice) >= parseInt(askPrice) ||
            parseFloat(quoteQty) < 1 ||
            needsFunds ||
            (parseFloat(quoteQty) || 0) > yesBalance
          }
          className="w-full text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 rounded-md px-3 py-2 transition-colors disabled:opacity-50 font-medium"
        >
          {submitting === "quote"
            ? "Posting..."
            : `Post ${bidPrice}c bid / ${askPrice}c ask × ${quoteQty}`}
        </button>
        <p className="text-[10px] text-white/20">
          Posts a resting bid (Buy Yes) and ask (Sell Yes) in a single transaction. Requires minted Yes tokens for the ask side.
        </p>
      </div>
    </div>
  );
}
