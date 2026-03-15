"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { BN, Program } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { USDC_MINT } from "@/hooks/useWalletState";
import { generateStrikes } from "@/lib/strikes";
import {
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
  findFeeVault,
  findSolTreasury,
  findTickerRegistry,
  padTicker,
} from "@/lib/pda";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import type { MockOracle } from "@/idl/mock_oracle";
import MockOracleIDL from "@/idl/mock_oracle.json";

interface CreateMarketPanelProps {
  ticker: string;
}

/** Compute 4:00 PM ET today as a unix timestamp. If already past, use tomorrow. */
function getNextMarketClose(): number {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etStr);

  const target = new Date(etNow);
  target.setHours(16, 0, 0, 0);

  if (etNow >= target) {
    target.setDate(target.getDate() + 1);
  }

  const utcTarget = new Date(
    now.getTime() + (target.getTime() - etNow.getTime()),
  );
  return Math.floor(utcTarget.getTime() / 1000);
}

type CreateStep = "idle" | "oracle" | "market" | "done";

const STEP_LABELS: Record<CreateStep, string> = {
  idle: "",
  oracle: "1/2 Creating oracle feed...",
  market: "2/2 Creating market...",
  done: "Market created!",
};

export function CreateMarketPanel({ ticker }: CreateMarketPanelProps) {
  const { program, provider } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const { data: config } = useGlobalConfig();

  const [prevClose, setPrevClose] = useState<number | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [customStrike, setCustomStrike] = useState("");
  const [step, setStep] = useState<CreateStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [oracleFeedExists, setOracleFeedExists] = useState<boolean | null>(null);

  const submitting = step !== "idle" && step !== "done";

  // Check if oracle feed exists
  useEffect(() => {
    const [feedAddr] = findPriceFeed(ticker);
    connection.getAccountInfo(feedAddr).then((info) => {
      setOracleFeedExists(info !== null && info.owner.equals(MOCK_ORACLE_PROGRAM_ID));
    }).catch(() => setOracleFeedExists(false));
  }, [connection, ticker]);

  // Fetch the previous close from the market data API
  useEffect(() => {
    let cancelled = false;
    setLoadingQuote(true);
    fetch(`/api/market-data/quotes?symbols=${encodeURIComponent(ticker)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const quote = data?.[0];
        if (quote?.last) setCurrentPrice(quote.last);
        if (quote?.prevclose) {
          setPrevClose(quote.prevclose);
        } else if (quote?.last) {
          setPrevClose(quote.last);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingQuote(false);
      });
    return () => { cancelled = true; };
  }, [ticker]);

  // Generate suggested strikes
  const strikes = useMemo(() => {
    if (!prevClose) return [];
    return generateStrikes(prevClose).strikes;
  }, [prevClose]);

  // Auto-select ATM strike
  useEffect(() => {
    if (strikes.length > 0 && selectedStrike === null) {
      const atm = strikes.reduce((best, s) =>
        Math.abs(s - (prevClose ?? 0)) < Math.abs(best - (prevClose ?? 0)) ? s : best,
      );
      setSelectedStrike(atm);
    }
  }, [strikes, selectedStrike, prevClose]);

  const fee = config ? Number(config.strikeCreationFee) / 1_000_000 : 0;
  const isAdmin = config && publicKey ? config.admin.equals(publicKey) : false;

  const handleCreate = useCallback(async () => {
    if (!program || !publicKey || !selectedStrike || !prevClose || !provider) return;
    setError(null);

    try {
      // Step 1: Create oracle feed if it doesn't exist
      if (!oracleFeedExists) {
        setStep("oracle");

        const oracleProgram = new Program<MockOracle>(
          MockOracleIDL as unknown as MockOracle,
          provider,
        );

        const tickerBytes = Array.from(padTicker(ticker));
        const [feedAddr] = findPriceFeed(ticker);

        // Initialize the feed
        const initTx = await oracleProgram.methods
          .initializeFeed(tickerBytes)
          .accountsPartial({
            authority: publicKey,
            priceFeed: feedAddr,
            systemProgram: SystemProgram.programId,
          })
          .transaction();

        await sendTransaction(initTx, { description: `Create ${ticker} oracle feed` });

        // Set initial price from market data
        const priceLamports = Math.round((currentPrice ?? prevClose) * 1_000_000);
        const confidence = Math.round(priceLamports * 0.001); // 0.1% confidence band
        const timestamp = Math.floor(Date.now() / 1000);

        const updateTx = await oracleProgram.methods
          .updatePrice(
            new BN(priceLamports),
            new BN(confidence),
            new BN(timestamp),
          )
          .accountsPartial({
            authority: publicKey,
            priceFeed: feedAddr,
          })
          .transaction();

        await sendTransaction(updateTx, { description: `Set ${ticker} price $${(priceLamports / 1_000_000).toFixed(2)}` });

        setOracleFeedExists(true);
      }

      // Step 2: Create the strike market
      setStep("market");

      const strikeLamports = BigInt(Math.round(selectedStrike * 1_000_000));
      const closeUnix = getNextMarketClose();
      const prevCloseLamports = BigInt(Math.round(prevClose * 1_000_000));
      const expiryDay = Math.floor(closeUnix / 86400);

      const tickerBytes = Array.from(padTicker(ticker));
      const [configPda] = findGlobalConfig();
      const [market] = findStrikeMarket(ticker, strikeLamports, closeUnix);
      const [yesMint] = findYesMint(market);
      const [noMint] = findNoMint(market);
      const [usdcVault] = findUsdcVault(market);
      const [escrowVault] = findEscrowVault(market);
      const [yesEscrow] = findYesEscrow(market);
      const [noEscrow] = findNoEscrow(market);
      const [orderBook] = findOrderBook(market);
      const [oracleFeed] = findPriceFeed(ticker);

      const accounts: Record<string, unknown> = {
        creator: publicKey,
        config: configPda,
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
      };

      // Non-admin creators need fee accounts
      if (!isAdmin && fee > 0) {
        const creatorUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
        const [feeVault] = findFeeVault();
        accounts.creatorUsdcAta = creatorUsdcAta;
        accounts.feeVault = feeVault;
      } else {
        accounts.creatorUsdcAta = null;
        accounts.feeVault = null;
      }

      const [tickerRegistryAddr] = findTickerRegistry();
      accounts.tickerRegistry = tickerRegistryAddr;

      const [solTreasuryAddr] = findSolTreasury();
      accounts.solTreasury = solTreasuryAddr;

      const tx = await program.methods
        .createStrikeMarket(
          tickerBytes,
          new BN(strikeLamports.toString()),
          expiryDay,
          new BN(closeUnix),
          new BN(prevCloseLamports.toString()),
        )
        .accountsPartial(accounts)
        .transaction();

      await sendTransaction(tx, {
        description: `Create ${ticker} $${selectedStrike} market`,
      });

      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["markets"] });

      setTimeout(() => {
        setStep("idle");
        setSelectedStrike(null);
      }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      if (msg.includes("already in use") || msg.includes("already been processed")) {
        setError("This market already exists. Try a different strike price.");
      } else {
        setError(msg.length > 150 ? msg.slice(0, 150) + "..." : msg);
      }
      setStep("idle");
    }
  }, [program, provider, publicKey, selectedStrike, prevClose, currentPrice, ticker, isAdmin, fee, oracleFeedExists, sendTransaction, queryClient]);

  if (!publicKey) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 px-6 py-10 text-center space-y-3">
        <h2 className="text-lg font-bold text-white">{ticker}</h2>
        <p className="text-white/50 text-sm">No active markets for {ticker} today.</p>
        <p className="text-white/30 text-xs">Connect your wallet to create one.</p>
      </div>
    );
  }

  if (loadingQuote) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 px-6 py-10 text-center space-y-3">
        <h2 className="text-lg font-bold text-white">{ticker}</h2>
        <p className="text-white/40 text-sm">Fetching market data...</p>
        <div className="h-6 w-32 mx-auto bg-white/10 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-6 py-8 space-y-6 max-w-lg mx-auto">
      <div className="text-center space-y-2">
        <h2 className="text-lg font-bold text-white">{ticker}</h2>
        <p className="text-white/50 text-sm">
          No active markets yet. Create one to start trading.
        </p>
        {prevClose && (
          <p className="text-white/30 text-xs">
            Previous close: ${prevClose.toFixed(2)}
            {currentPrice && currentPrice !== prevClose && (
              <span className="ml-2">Current: ${currentPrice.toFixed(2)}</span>
            )}
          </p>
        )}
      </div>

      {/* Strike price selection */}
      <div className="space-y-3">
        <label className="block text-xs text-white/50">Select strike price</label>
        {strikes.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-center">
            {strikes.map((strike) => {
              const isAtm = prevClose && Math.abs(strike - prevClose) < (prevClose * 0.035);
              return (
                <button
                  key={strike}
                  onClick={() => { setSelectedStrike(strike); setCustomStrike(""); }}
                  className={`px-3 py-1.5 rounded-md text-sm font-mono transition-all ${
                    selectedStrike === strike && customStrike === ""
                      ? "bg-accent/20 text-accent border border-accent/30"
                      : "bg-white/5 text-white/50 border border-white/10 hover:text-white/80 hover:border-white/20"
                  }`}
                >
                  ${strike}
                  {isAtm && (
                    <span className="ml-1 text-[9px] text-white/30">ATM</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2">
          {strikes.length > 0 && (
            <span className="text-xs text-white/30 shrink-0">or</span>
          )}
          <input
            type="number"
            step="1"
            min="1"
            value={customStrike}
            onChange={(e) => {
              setCustomStrike(e.target.value);
              const val = parseFloat(e.target.value);
              setSelectedStrike(val > 0 ? val : null);
            }}
            placeholder="Custom strike price"
            className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none font-mono"
          />
        </div>
      </div>

      {/* Info line */}
      <div className="text-center text-xs text-white/30 space-y-1">
        <p>Market closes at 4:00 PM ET today</p>
        {!oracleFeedExists && (
          <p className="text-blue-400/60">Oracle feed will be created automatically</p>
        )}
        {!isAdmin && fee > 0 && (
          <p className="text-yellow-400/60">
            Creation fee: ${fee.toFixed(2)} USDC
          </p>
        )}
      </div>

      {/* Progress indicator */}
      {submitting && (
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300 rounded-full"
              style={{ width: step === "oracle" ? "33%" : "66%" }}
            />
          </div>
          <span className="text-[10px] text-white/40 shrink-0">{STEP_LABELS[step]}</span>
        </div>
      )}

      {error && <p className="text-xs text-red-400 text-center">{error}</p>}

      <button
        onClick={handleCreate}
        disabled={submitting || !selectedStrike || step === "done"}
        className={`w-full rounded-md py-2.5 text-sm font-semibold transition-colors ${
          step === "done"
            ? "bg-green-500/20 text-green-400"
            : "bg-accent/20 text-white hover:bg-accent/30 disabled:bg-white/5 disabled:text-white/20"
        }`}
      >
        {submitting
          ? STEP_LABELS[step]
          : step === "done"
          ? "Market created!"
          : selectedStrike
          ? `Create ${ticker} $${selectedStrike} Market`
          : "Select a strike price"}
      </button>
    </div>
  );
}
