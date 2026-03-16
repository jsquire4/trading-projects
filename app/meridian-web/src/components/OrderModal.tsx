"use client";

/**
 * OrderModal — single point of commitment for all order actions.
 *
 * Adapts based on context:
 * - Taker filling existing orders (sweep preview, Fill All)
 * - Maker posting new order (qty input, rent shown if needed)
 * - New strike creation (bundles create_strike_market + place_order)
 * - New ticker registration (bundles add_ticker + oracle + market + order)
 *
 * Pre-filled from the order tree row the user clicked.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { usePlaceOrder, type PlaceOrderParams } from "@/hooks/usePlaceOrder";
import { usePositions } from "@/hooks/usePositions";
import { useWalletState, USDC_MINT } from "@/hooks/useWalletState";
import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { PayoffDisplay } from "@/components/PayoffDisplay";
import type { OrderBookData } from "@/hooks/useMarkets";
import { Side, type ActiveOrder } from "@/lib/orderbook";
import { extractErrorMessage } from "@/lib/transactionErrors";
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
  findFeeVault,
  findSolTreasury,
  findTickerRegistry,
  padTicker,
} from "@/lib/pda";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderModalSide = "buy-yes" | "buy-no" | "sell-yes" | "sell-no";

export interface OrderModalProps {
  open: boolean;
  onClose: () => void;
  /** Which side the user clicked — left column = buy-yes, right column = buy-no */
  side: OrderModalSide;
  /** Price level clicked (1-99 in Yes cents) */
  yesPrice: number;
  /** Ticker symbol */
  ticker: string;
  /** Strike price in USDC lamports */
  strikePrice: number;
  /** Market public key (null if strike doesn't exist on-chain yet) */
  marketPubkey: PublicKey | null;
  /** Market's ALT address (for versioned transactions) */
  altAddress?: PublicKey;
  /** Current order book data (null if no market exists) */
  orderBookData: OrderBookData | null | undefined;
  /** Callback after successful order */
  onSuccess?: (signature: string) => void;
  /** Called when a new market is created (passes market pubkey base58) */
  onMarketCreated?: (marketKey: string) => void;
}

interface SweepLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_LAMPORTS = 1_000_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrderModal({
  open,
  onClose,
  side,
  yesPrice,
  ticker,
  strikePrice,
  marketPubkey,
  altAddress,
  orderBookData,
  onSuccess,
  onMarketCreated,
}: OrderModalProps) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { data: config } = useGlobalConfig();
  const queryClient = useQueryClient();
  const { placeOrder } = usePlaceOrder();
  const { data: positions = [] } = usePositions();
  const { solBalance, usdcBalance } = useWalletState();
  const [quantity, setQuantity] = useState("");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [submitting, setSubmitting] = useState(false);
  const [activeSide, setActiveSide] = useState<OrderModalSide>(side);
  const [error, setError] = useState<string | null>(null);

  // Position conflict check: on-chain blocks holding both Yes and No on the same strike.
  // Check user's token balances for this market and warn before submit.
  const positionConflict = useMemo(() => {
    if (!marketPubkey) return null;
    const marketKey = marketPubkey.toBase58();
    const pos = positions.find((p) => p.market.publicKey.toBase58() === marketKey);
    if (!pos) return null;

    const holdsYes = pos.yesBal > BigInt(0);
    const holdsNo = pos.noBal > BigInt(0);

    // Buy Yes / Sell No requires no No tokens
    if ((activeSide === "buy-yes") && holdsNo) {
      return "You hold No tokens on this strike. Sell or pair-burn them before buying Yes.";
    }
    // Buy No / Sell No (NO_BID) requires no Yes tokens
    if ((activeSide === "buy-no") && holdsYes) {
      return "You hold Yes tokens on this strike. Sell or pair-burn them before buying No.";
    }
    // Sell No requires no Yes tokens (NO_BID check)
    if ((activeSide === "sell-no") && holdsYes) {
      return "You hold Yes tokens on this strike. Sell or pair-burn them before selling No.";
    }

    return null;
  }, [marketPubkey, positions, activeSide]);

  // Reset state when modal opens or side changes
  useEffect(() => {
    if (open) {
      setQuantity("");
      setOrderType("limit");
      setSubmitting(false);
      setActiveSide(side);
      setError(null);
    }
  }, [open, side]);

  // Derived values
  const noPrice = 100 - yesPrice;
  const isBuy = activeSide === "buy-yes" || activeSide === "buy-no";
  const isYesSide = activeSide === "buy-yes" || activeSide === "sell-yes";
  const displayPrice = isYesSide ? yesPrice : noPrice;
  const impliedProbability = isYesSide ? yesPrice : noPrice;
  const quantityNum = parseInt(quantity, 10) || 0;
  const quantityLamports = quantityNum * USDC_LAMPORTS;

  // Compute available liquidity at this level and sweep levels
  const { availableAtLevel, sweepLevels, totalAvailable } = useMemo(() => {
    if (!orderBookData) return { availableAtLevel: 0, sweepLevels: [], totalAvailable: 0 };

    const orders = orderBookData.raw.orders;
    let matchable: ActiveOrder[] = [];

    if (activeSide === "buy-yes") {
      // Buying Yes = matching against Yes asks at or below our price
      matchable = orders
        .filter((o) => o.side === Side.YesAsk && o.priceLevel <= yesPrice)
        .sort((a, b) => a.priceLevel - b.priceLevel);
    } else if (activeSide === "sell-yes") {
      // Selling Yes = matching against USDC bids AND No-backed bids (merge path).
      // On-chain, match_against_bids considers both sides with combined FIFO.
      const maxNoPrice = 100 - yesPrice;
      const usdcBids = orders
        .filter((o) => o.side === Side.UsdcBid && o.priceLevel >= yesPrice);
      const noBids = orders
        .filter((o) => o.side === Side.NoBackedBid && o.priceLevel <= maxNoPrice);
      matchable = [...usdcBids, ...noBids]
        .sort((a, b) => b.priceLevel - a.priceLevel); // best (highest) bid first
    } else if (activeSide === "sell-no") {
      // Selling No = matching against Yes asks (merge) at complementary prices
      const maxYesAsk = 100 - noPrice; // = yesPrice
      matchable = orders
        .filter((o) => o.side === Side.YesAsk && o.priceLevel <= maxYesAsk)
        .sort((a, b) => a.priceLevel - b.priceLevel);
    } else {
      // buy-no: the actual tx is mint_pair + sell_yes(side=1), which matches
      // against USDC bids and No-backed bids — NOT Yes asks.
      const yesSellPrice = 100 - noPrice; // = yesPrice
      const usdcBids = orders
        .filter((o) => o.side === Side.UsdcBid && o.priceLevel >= yesSellPrice)
        .sort((a, b) => b.priceLevel - a.priceLevel);
      const noBids = orders
        .filter((o) => o.side === Side.NoBackedBid && o.priceLevel <= 100 - yesSellPrice)
        .sort((a, b) => b.priceLevel - a.priceLevel);
      // Combined, sorted by best price first (highest bid)
      matchable = [...usdcBids, ...noBids].sort((a, b) => b.priceLevel - a.priceLevel);
    }

    // Group by price level
    const levelMap = new Map<number, { qty: number; count: number }>();
    for (const o of matchable) {
      const existing = levelMap.get(o.priceLevel) ?? { qty: 0, count: 0 };
      existing.qty += Number(o.quantity) / USDC_LAMPORTS;
      existing.count += 1;
      levelMap.set(o.priceLevel, existing);
    }

    const levels: SweepLevel[] = [];
    for (const [price, { qty, count }] of levelMap) {
      levels.push({ price, quantity: qty, orderCount: count });
    }
    levels.sort((a, b) => a.price - b.price);

    const atLevel = levelMap.get(yesPrice)?.qty ?? 0;
    const total = levels.reduce((sum, l) => sum + l.quantity, 0);

    return { availableAtLevel: atLevel, sweepLevels: levels, totalAvailable: total };
  }, [orderBookData, activeSide, yesPrice, noPrice]);

  // Cost calculation
  const totalCostUSDC = useMemo(() => {
    if (quantityNum <= 0) return 0;

    if (orderType === "market" || quantityNum <= availableAtLevel) {
      // Simple: all at the clicked price
      return (quantityNum * displayPrice) / 100;
    }

    // Sweep across levels
    let remaining = quantityNum;
    let cost = 0;
    for (const level of sweepLevels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, level.quantity);
      const levelPrice = isYesSide ? level.price : 100 - level.price;
      cost += (fillQty * levelPrice) / 100;
      remaining -= fillQty;
    }

    // Remaining rests as limit at the clicked price
    if (remaining > 0) {
      cost += (remaining * displayPrice) / 100;
    }

    return cost;
  }, [quantityNum, displayPrice, orderType, availableAtLevel, sweepLevels, activeSide]);

  // Weighted average price for sweeps
  const weightedAvgPrice = useMemo(() => {
    if (quantityNum <= 0) return displayPrice;
    if (quantityNum <= availableAtLevel) return displayPrice;

    let remaining = quantityNum;
    let totalWeighted = 0;
    let totalFilled = 0;

    for (const level of sweepLevels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, level.quantity);
      const levelPrice = isYesSide ? level.price : 100 - level.price;
      totalWeighted += fillQty * levelPrice;
      totalFilled += fillQty;
      remaining -= fillQty;
    }

    if (totalFilled === 0) return displayPrice;
    return Math.round(totalWeighted / totalFilled);
  }, [quantityNum, displayPrice, availableAtLevel, sweepLevels, activeSide]);

  // How much fills immediately vs. rests
  const fillsImmediately = Math.min(quantityNum, Math.floor(totalAvailable));
  const restsAsLimit = orderType === "limit" ? Math.max(0, quantityNum - fillsImmediately) : 0;

  // Fill All handler
  const handleFillAll = useCallback(() => {
    if (totalAvailable > 0) {
      setQuantity(String(Math.floor(totalAvailable)));
    }
  }, [totalAvailable]);

  // Create market helper — used when marketPubkey is null (new strike)
  const createMarket = useCallback(async (): Promise<PublicKey | null> => {
    if (!program || !publicKey || !config) return null;

    const closeUnix = (() => {
      const now = new Date();
      const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
      const etNow = new Date(etStr);
      const target = new Date(etNow);
      target.setHours(16, 0, 0, 0);
      if (etNow >= target) target.setDate(target.getDate() + 1);
      return Math.floor(now.getTime() / 1000 + (target.getTime() - etNow.getTime()) / 1000);
    })();

    const strikeLamports = BigInt(strikePrice);
    const expiryDay = Math.floor(closeUnix / 86400);
    const prevCloseLamports = strikeLamports; // use strike as prev close approximation

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
    const [tickerRegistryAddr] = findTickerRegistry();
    const [solTreasuryAddr] = findSolTreasury();

    const isAdmin = config.admin.equals(publicKey);
    const fee = Number(config.strikeCreationFee);

    const accounts: Record<string, unknown> = {
      creator: publicKey,
      config: configPda,
      market, yesMint, noMint, usdcVault, escrowVault,
      yesEscrow, noEscrow, orderBook, oracleFeed,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      tickerRegistry: tickerRegistryAddr,
      solTreasury: solTreasuryAddr,
    };

    if (!isAdmin && fee > 0) {
      accounts.creatorUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
      const [feeVault] = findFeeVault();
      accounts.feeVault = feeVault;
    } else {
      accounts.creatorUsdcAta = null;
      accounts.feeVault = null;
    }

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

    const sig = await sendTransaction(tx, { description: `Create ${ticker} $${(strikePrice / USDC_LAMPORTS).toFixed(0)} market` });
    if (!sig) return null;

    queryClient.invalidateQueries({ queryKey: ["markets"] });
    return market;
  }, [program, publicKey, config, ticker, strikePrice, sendTransaction, queryClient]);

  // Submit — handles both existing and new markets
  const handleSubmit = useCallback(async () => {
    if (!publicKey || quantityNum <= 0) return;

    setError(null);

    // Pre-submit balance validation — include strike creation fee for new markets
    const creationFeeUsdc = (isNewMarket && config && !config.admin.equals(publicKey))
      ? Number(config.strikeCreationFee) / USDC_LAMPORTS
      : 0;
    const totalUsdcNeeded = (isBuy ? totalCostUSDC : 0) + creationFeeUsdc;
    if (totalUsdcNeeded > 0 && usdcBalance !== null && totalUsdcNeeded > usdcBalance) {
      const breakdown = creationFeeUsdc > 0
        ? ` ($${totalCostUSDC.toFixed(2)} order + $${creationFeeUsdc.toFixed(2)} market creation fee)`
        : "";
      setError(`Insufficient USDC. You have $${usdcBalance.toFixed(2)} but need $${totalUsdcNeeded.toFixed(2)}${breakdown}. Use the faucet to get test funds.`);
      return;
    }
    // Seller-side: check token inventory
    if (activeSide === "sell-yes" && marketPubkey) {
      const pos = positions.find((p) => p.market.publicKey.toBase58() === marketPubkey.toBase58());
      const yesBal = pos ? Number(pos.yesBal) / USDC_LAMPORTS : 0;
      if (yesBal < quantityNum) {
        setError(`Insufficient Yes tokens. You hold ${yesBal.toFixed(0)} but want to sell ${quantityNum}.`);
        return;
      }
    }
    if (activeSide === "sell-no" && marketPubkey) {
      const pos = positions.find((p) => p.market.publicKey.toBase58() === marketPubkey.toBase58());
      const noBal = pos ? Number(pos.noBal) / USDC_LAMPORTS : 0;
      if (noBal < quantityNum) {
        setError(`Insufficient No tokens. You hold ${noBal.toFixed(0)} but want to sell ${quantityNum}.`);
        return;
      }
    }
    const minSol = marketPubkey ? 0.01 : 0.05; // new market needs more SOL for rent
    if (solBalance !== null && solBalance < minSol) {
      setError(`Insufficient SOL. You have ${solBalance.toFixed(4)} SOL but need ~${minSol} SOL${!marketPubkey ? " (includes market creation rent)" : ""}.`);
      return;
    }

    setSubmitting(true);
    try {
      // If market doesn't exist yet, create it first
      let resolvedMarket = marketPubkey;
      if (!resolvedMarket) {
        resolvedMarket = await createMarket();
        if (!resolvedMarket) {
          setError("Market creation failed. Check your wallet for details.");
          return;
        }
        // Brief delay to let the market account propagate
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Now place the order on the (possibly just-created) market
      const placeOrderSide = (() => {
        switch (activeSide) {
          case "buy-yes": return "buy-yes" as const;
          case "sell-yes": return "sell-yes" as const;
          case "sell-no": return "sell-no" as const;
          case "buy-no": return "buy-no" as const;
        }
      })();

      const params: PlaceOrderParams = {
        marketPubkey: resolvedMarket,
        marketKey: resolvedMarket.toBase58(),
        side: placeOrderSide,
        orderType,
        effectivePrice: yesPrice,
        quantityLamports,
        orderBookData,
        altAddress,
      };

      const signature = await placeOrder(params);
      if (signature) {
        if (!marketPubkey && resolvedMarket) {
          onMarketCreated?.(resolvedMarket.toBase58());
        }
        onSuccess?.(signature);
        onClose();
      } else {
        setError("Order placement failed. The market was created — try placing the order again from the trade page.");
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [publicKey, marketPubkey, quantityNum, activeSide, orderType, yesPrice, quantityLamports, orderBookData, altAddress, placeOrder, onSuccess, onClose, createMarket, isBuy, usdcBalance, solBalance, totalCostUSDC]);

  if (!open) return null;

  const strikeDollars = (strikePrice / USDC_LAMPORTS).toFixed(0);
  const sideLabels: Record<OrderModalSide, string> = {
    "buy-yes": "Buy Yes",
    "sell-yes": "Sell Yes",
    "buy-no": "Buy No",
    "sell-no": "Sell No",
  };
  const sideLabel = sideLabels[activeSide];
  const sideColor = isYesSide ? "text-green-400" : "text-red-400";
  const sideBgColor = isYesSide ? "bg-green-500/20 border-green-500/30" : "bg-red-500/20 border-red-500/30";

  // Market doesn't exist yet — show creation flow
  const isNewMarket = !marketPubkey;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-[#0f0f0f] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-bold text-white">
              <span className={sideColor}>{sideLabel}</span> {ticker} ${strikeDollars}
            </h2>
            <p className="text-xs text-white/40">
              @ {displayPrice}¢ · {impliedProbability}% implied probability
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Buy/Sell toggle */}
          <div className="grid grid-cols-4 gap-1 bg-white/5 rounded-lg p-1">
            {(["buy-yes", "sell-yes", "buy-no", "sell-no"] as OrderModalSide[]).map((s) => (
              <button
                key={s}
                onClick={() => setActiveSide(s)}
                className={`py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                  activeSide === s
                    ? s.includes("yes")
                      ? "bg-green-500/20 text-green-400"
                      : "bg-red-500/20 text-red-400"
                    : "text-white/40 hover:text-white/60"
                }`}
              >
                {sideLabels[s]}
              </button>
            ))}
          </div>

          {/* Position conflict warning */}
          {positionConflict && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold">Position Conflict</span>
              </div>
              <p>{positionConflict}</p>
              <p className="text-amber-300/60 mt-1">
                You cannot hold both Yes and No tokens on the same strike. This is enforced on-chain.
              </p>
            </div>
          )}

          {/* Available liquidity */}
          {!isNewMarket && totalAvailable > 0 && (
            <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/50">Available to fill</span>
                <span className="text-white font-mono">{Math.floor(totalAvailable)} contracts</span>
              </div>
              {sweepLevels.length > 1 && quantityNum > availableAtLevel && (
                <div className="space-y-1">
                  {sweepLevels.slice(0, 5).map((level) => {
                    const levelDisplay = isYesSide ? level.price : 100 - level.price;
                    return (
                      <div key={level.price} className="flex items-center justify-between text-xs text-white/40">
                        <span>{level.orderCount} order{level.orderCount !== 1 ? "s" : ""} @ {levelDisplay}¢</span>
                        <span className="font-mono">{Math.floor(level.quantity)} contracts</span>
                      </div>
                    );
                  })}
                  {sweepLevels.length > 5 && (
                    <div className="text-xs text-white/30">+{sweepLevels.length - 5} more levels...</div>
                  )}
                </div>
              )}
              <button
                onClick={handleFillAll}
                className={`w-full rounded-md py-1.5 text-xs font-medium transition-colors border ${sideBgColor} ${sideColor}`}
              >
                Fill All ({Math.floor(totalAvailable)} contracts)
              </button>
            </div>
          )}

          {/* New market notice */}
          {isNewMarket && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm text-amber-300">
              This strike doesn't exist yet. Creating a market requires rent deposit.
            </div>
          )}

          {/* Quantity input */}
          <div>
            <label className="block text-xs text-white/50 mb-1">Quantity (contracts)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Enter quantity"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 font-mono focus:border-accent focus:outline-none"
              autoFocus
            />
          </div>

          {/* Order type toggle — disabled for new markets (no resting liquidity to fill) */}
          <div className="flex gap-1 bg-white/5 rounded-lg p-1">
            <button
              onClick={() => setOrderType("limit")}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                orderType === "limit"
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/60"
              }`}
            >
              Limit
            </button>
            <button
              onClick={() => !isNewMarket && setOrderType("market")}
              disabled={isNewMarket}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isNewMarket
                  ? "text-white/20 cursor-not-allowed"
                  : orderType === "market"
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/60"
              }`}
              title={isNewMarket ? "New strikes require limit orders — no resting liquidity to fill" : undefined}
            >
              Market
            </button>
          </div>

          {/* Payoff explanation — uses PayoffDisplay component for all sides */}
          <PayoffDisplay
            side={isYesSide ? "yes" : "no"}
            action={isBuy ? "buy" : "sell"}
            price={displayPrice}
            ticker={ticker}
            strikePrice={strikePrice}
          />

          {/* Cost summary */}
          {quantityNum > 0 && (
            <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/50">Total cost</span>
                <span className="text-white font-bold font-mono">${totalCostUSDC.toFixed(2)} USDC</span>
              </div>
              {quantityNum > availableAtLevel && sweepLevels.length > 1 && (
                <div className="flex items-center justify-between text-xs text-white/40">
                  <span>Avg price</span>
                  <span className="font-mono">{weightedAvgPrice}¢</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-white/40">
                <span>Implied probability</span>
                <span className="font-mono">{impliedProbability}%</span>
              </div>

              {/* Fill/rest breakdown */}
              {orderType === "limit" && fillsImmediately > 0 && restsAsLimit > 0 && (
                <div className="pt-2 border-t border-white/5 space-y-1">
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Fills immediately</span>
                    <span className="font-mono">{fillsImmediately} contracts</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Rests as limit order</span>
                    <span className="font-mono">{restsAsLimit} contracts</span>
                  </div>
                </div>
              )}

              {/* Rent deposit for new market / new slot */}
              {isNewMarket && (
                <div className="pt-2 border-t border-white/5 space-y-1">
                  <div className="flex items-center justify-between text-xs text-amber-400/70">
                    <span>Market creation rent</span>
                    <span className="font-mono">~0.02 SOL</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-amber-400/70">
                    <span>Order slot rent</span>
                    <span className="font-mono">~0.001 SOL</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-amber-300">
                    <span>Total rent</span>
                    <span className="font-mono">~0.021 SOL</span>
                  </div>
                </div>
              )}
              {!isNewMarket && restsAsLimit > 0 && (
                <div className="pt-2 border-t border-white/5">
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Slot rent (if new level)</span>
                    <span className="font-mono">~0.001 SOL</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div className="mx-6 mb-0 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
            <div className="flex items-start gap-2">
              <span className="text-red-400 font-bold shrink-0">Error</span>
              <p>{error}</p>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 py-2.5 text-sm font-medium text-white/50 hover:text-white/70 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || quantityNum <= 0 || !publicKey || !!positionConflict}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors border ${
              submitting
                ? "bg-white/5 text-white/30 border-white/10"
                : `${sideBgColor} ${sideColor} hover:opacity-80`
            } disabled:opacity-30`}
          >
            {submitting
              ? (isNewMarket ? "Creating market..." : "Confirming...")
              : isNewMarket
                ? `Create Market + ${sideLabel} ${quantityNum > 0 ? quantityNum : ""}`
                : `${sideLabel} ${quantityNum > 0 ? quantityNum + " contracts" : ""}`
            }
          </button>
        </div>
      </div>
    </div>
  );
}
