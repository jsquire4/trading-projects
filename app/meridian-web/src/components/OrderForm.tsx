"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { PublicKey, Transaction, AccountMeta, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAnchorProgram } from "@/hooks/useAnchorProgram";
import { useTransaction } from "@/hooks/useTransaction";
import { useNetwork } from "@/hooks/useNetwork";
import { usePositions } from "@/hooks/usePositions";
import { useOrderBook } from "@/hooks/useMarkets";
import { Side, type ActiveOrder } from "@/lib/orderbook";
import { USDC_MINT } from "@/hooks/useWalletState";
import { TradeConfirmationModal } from "@/components/TradeConfirmationModal";
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

// Side encoding (on-chain has only 3 sides):
//   0 = Buy Yes (bid on yes tokens, spends USDC)
//   1 = Sell Yes (ask yes tokens, receives USDC)
//   2 = Sell No (no-backed bid — escrows No tokens, receives USDC via merge/burn)
// "Buy No" is a composite: mint pair + sell Yes on the order book.
// Order type: 0 = Market, 1 = Limit
type OrderSide = "buy-yes" | "sell-yes" | "sell-no" | "buy-no";

interface OrderFormProps {
  marketKey: string;
  ticker: string;
  strikePrice: number;
  /** Externally-set price (e.g. from OrderBook click) */
  initialPrice?: number | null;
  /** Callback after successful transaction */
  onTransactionSuccess?: (signature: string) => void;
}

const LAMPORTS_PER_TOKEN = 1_000_000;

function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes":
      return 0;
    case "sell-yes":
    case "buy-no":
      // Buy No is implemented as: mint pair + sell Yes (side=1)
      return 1;
    case "sell-no":
      // Sell No = No-backed bid (side 2) — user offers No tokens at stated price
      return 2;
  }
}

export function OrderForm({ marketKey, ticker, strikePrice, initialPrice, onTransactionSuccess }: OrderFormProps) {
  const [side, setSide] = useState<OrderSide>("buy-yes");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState<string>("50");
  const [dollarAmount, setDollarAmount] = useState<string>("10");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Update price when externally set (e.g. OrderBook click)
  useEffect(() => {
    if (initialPrice != null && initialPrice >= 1 && initialPrice <= 99) {
      setPrice(String(initialPrice));
      setOrderType("limit");
    }
  }, [initialPrice]);

  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey: walletPublicKey } = useWallet();
  const { isMainnet } = useNetwork();
  const { data: positions = [] } = usePositions();
  const queryClient = useQueryClient();

  const marketPubkey = useMemo(() => new PublicKey(marketKey), [marketKey]);
  const { data: orderBookData } = useOrderBook(marketKey);

  // Position constraint: can't Buy Yes while holding No, or Buy No while holding Yes
  const currentPosition = useMemo(() => {
    return positions.find((p) => p.market.publicKey.toBase58() === marketKey);
  }, [positions, marketKey]);

  const positionConflict = useMemo((): string | null => {
    if (!currentPosition) return null;
    if ((side === "buy-yes") && currentPosition.noBal > BigInt(0)) {
      return "You hold No tokens for this strike. Sell your No position first.";
    }
    if ((side === "buy-no") && currentPosition.yesBal > BigInt(0)) {
      return "You hold Yes tokens for this strike. Sell your Yes position first.";
    }
    if ((side === "sell-no") && currentPosition.yesBal > BigInt(0) && currentPosition.noBal === BigInt(0)) {
      return "You hold Yes tokens but no No tokens. Sell your Yes position first, or use Buy No to switch sides.";
    }
    return null;
  }, [side, currentPosition]);

  // Check if the order book has liquidity on the side the user needs
  const marketOrderWarning = useMemo((): string | null => {
    if (orderType !== "market") return null;
    if (!orderBookData) return null;
    const yesView = orderBookData.yesView;
    // Buy Yes = needs asks on Yes book. Sell Yes = needs bids on Yes book.
    // Sell No = matches against Yes asks (merge/burn).
    // Buy No = sell Yes side, needs bids on Yes book.
    if (side === "buy-yes" && (yesView.bestAsk === null)) {
      return "No sell orders on the book — market buy can't fill. Use a limit order instead.";
    }
    if ((side === "sell-yes" || side === "buy-no") && (yesView.bestBid === null)) {
      return "No buy orders on the book — market order can't fill. Use a limit order instead.";
    }
    // Sell No matches against Yes asks (via merge/burn).
    // Check if there are Yes asks available (shown as bids in the No view after inversion).
    if (side === "sell-no") {
      if (yesView.bestAsk === null) {
        return "No Yes asks on the book — sell No can't fill. Use a limit order instead.";
      }
    }
    return null;
  }, [orderType, orderBookData, side]);

  const effectivePrice = useMemo(() => {
    if (orderType === "market") return null;
    const p = parseInt(price, 10);
    if (isNaN(p) || p < 1 || p > 99) return null;
    return p;
  }, [price, orderType]);

  // For market orders, use best ask (buys) or best bid (sells) from the order book
  const marketPrice = useMemo((): number | null => {
    if (orderType !== "market" || !orderBookData) return null;
    const yesView = orderBookData.yesView;
    const noView = orderBookData.noView;
    if (side === "buy-yes") return yesView.bestAsk;
    if (side === "sell-yes") return yesView.bestBid;
    // Buy No: we sell Yes, so price is from Yes bids. But user sees No price = 100 - yesBid.
    if (side === "buy-no") {
      const yesBid = yesView.bestBid;
      return yesBid !== null ? 100 - yesBid : null;
    }
    // Sell No: best price is the highest Yes ask complement available
    if (side === "sell-no") return noView.bestBid;
    return null;
  }, [orderType, orderBookData, side]);

  // Dollar-denominated input: compute quantity from dollar amount and price
  const quantityLamports = useMemo(() => {
    const dollars = parseFloat(dollarAmount);
    if (isNaN(dollars) || dollars <= 0) return null;

    // For all sides, the user's entered price represents what they pay per contract.
    // cost per contract = price / 100 (price is in cents)
    const priceForCalc = effectivePrice ?? marketPrice;
    if (!priceForCalc) return null;

    const costPerContract = priceForCalc / 100;
    if (costPerContract <= 0) return null;

    const qty = dollars / costPerContract;
    const lamports = Math.floor(qty * LAMPORTS_PER_TOKEN);
    return lamports >= LAMPORTS_PER_TOKEN ? lamports : null;
  }, [dollarAmount, effectivePrice, marketPrice]);

  // Derived quantity for display
  const derivedQuantity = useMemo(() => {
    if (!quantityLamports) return null;
    return quantityLamports / LAMPORTS_PER_TOKEN;
  }, [quantityLamports]);

  const displayPrice = effectivePrice ?? marketPrice;

  const estimatedCost = useMemo(() => {
    if (!quantityLamports || !displayPrice) return null;
    return (displayPrice / 100) * (quantityLamports / LAMPORTS_PER_TOKEN);
  }, [quantityLamports, displayPrice]);

  // Payout estimate: for buys, payout is $1 per contract if condition is met
  const estimatedPayout = useMemo(() => {
    if (!quantityLamports) return null;
    return quantityLamports / LAMPORTS_PER_TOKEN;
  }, [quantityLamports]);

  const isValid = useMemo(() => {
    if (!quantityLamports || quantityLamports < LAMPORTS_PER_TOKEN) return false;
    if (orderType === "limit" && !effectivePrice) return false;
    if (!walletPublicKey) return false;
    return true;
  }, [quantityLamports, effectivePrice, orderType, walletPublicKey]);

  const handleSubmitDirect = useCallback(async () => {
    if (!isValid || !program || !walletPublicKey || submitting) return;
    setSubmitting(true);

    try {
      const user = walletPublicKey;
      const [config] = findGlobalConfig();
      const [orderBookPda] = findOrderBook(marketPubkey);
      const [usdcVault] = findUsdcVault(marketPubkey);
      const [escrowVault] = findEscrowVault(marketPubkey);
      const [yesEscrow] = findYesEscrow(marketPubkey);
      const [noEscrow] = findNoEscrow(marketPubkey);
      const [yesMint] = findYesMint(marketPubkey);
      const [noMint] = findNoMint(marketPubkey);

      // Derive user ATAs
      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, user);
      const userYesAta = await getAssociatedTokenAddress(yesMint, user);
      const userNoAta = await getAssociatedTokenAddress(noMint, user);

      // Idempotent ATA creation — no-ops if accounts already exist, creates if missing
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userNoAta, user, noMint));

      if (side === "buy-no") {
        // Atomic Buy No: mint pair + sell Yes + (optional) redeem cleanup
        // Step 1: Mint pair — gives user Yes + No tokens
        const mintPairIx = await program.methods
          .mintPair(new BN(quantityLamports!))
          .accountsPartial({
            user,
            config,
            market: marketPubkey,
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
          .instruction();
        tx.add(mintPairIx);

        // Step 2: Sell Yes on the order book
        // For buy-no, user enters a No price. The Yes sell price = 100 - noPrice.
        const noPrice = orderType === "market" ? 1 : effectivePrice!;
        const yesSellPrice = orderType === "market" ? 1 : (100 - noPrice);
        const orderTypeU8 = orderType === "limit" ? 1 : 0;
        const maxFills = 10;

        // Build remaining_accounts for Sell Yes: matches USDC bids + No-backed bids
        const makerAccounts: AccountMeta[] = [];
        if (orderBookData) {
          const orders = orderBookData.raw.orders;
          const usdcBids = orders
            .filter((o) => o.side === Side.UsdcBid && o.priceLevel >= yesSellPrice);
          const noBids = orders
            .filter((o) => o.side === Side.NoBackedBid && o.priceLevel <= (100 - yesSellPrice));

          const allBids: { order: ActiveOrder; isMerge: boolean }[] = [];
          for (let level = 99; level >= 1; level--) {
            for (const o of usdcBids.filter((b) => b.priceLevel === level)) {
              allBids.push({ order: o, isMerge: false });
            }
            for (const o of noBids.filter((b) => b.priceLevel === level)) {
              allBids.push({ order: o, isMerge: true });
            }
          }

          for (const { order, isMerge } of allBids) {
            if (makerAccounts.length >= maxFills) break;
            let makerAta: PublicKey;
            if (!isMerge) {
              makerAta = getAssociatedTokenAddressSync(yesMint, order.owner);
            } else {
              makerAta = getAssociatedTokenAddressSync(USDC_MINT, order.owner);
            }
            makerAccounts.push({ pubkey: makerAta, isSigner: false, isWritable: true });
          }
        }

        const sellYesIx = await program.methods
          .placeOrder(1, yesSellPrice, new BN(quantityLamports!), orderTypeU8, maxFills)
          .accountsPartial({
            user,
            config,
            market: marketPubkey,
            orderBook: orderBookPda,
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
          })
          .remainingAccounts(makerAccounts)
          .instruction();
        tx.add(sellYesIx);

        // Step 3: For market orders, add pair-burn cleanup to recover USDC from unfilled portion
        // If sell Yes partially fills, user still holds Yes+No tokens for the unfilled qty.
        // Redeem mode 0 = pair burn — burns min(yes, no) and returns USDC.
        if (orderType === "market") {
          const redeemIx = await program.methods
            .redeem(0, new BN(quantityLamports!))
            .accountsPartial({
              user,
              config,
              market: marketPubkey,
              yesMint,
              noMint,
              usdcVault,
              userUsdcAta,
              userYesAta,
              userNoAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();
          tx.add(redeemIx);
        }

        const signature = await sendTransaction(tx, { description: "Buy No (Atomic)" });
        if (signature) {
          // Optimistic updates: immediately refetch related queries
          queryClient.invalidateQueries({ queryKey: ["positions"] });
          queryClient.invalidateQueries({ queryKey: ["order-book", marketKey] });
          queryClient.invalidateQueries({ queryKey: ["cost-basis"] });
          onTransactionSuccess?.(signature);
        }
      } else {
        // Standard order flow (buy-yes, sell-yes, sell-no)
        const sideU8 = sideToU8(side);
        // Market orders: use worst acceptable price
        //   Buy Yes (side=0): price=99 (accept any ask up to 99c)
        //   Sell Yes (side=1): price=1 (accept any bid down to 1c)
        //   Sell No (side=2): price=1 (on-chain: max_yes_ask = 100-1 = 99, sweep all asks)
        const priceU8 = orderType === "market"
          ? (side === "buy-yes" ? 99 : 1)
          : effectivePrice!;
        const orderTypeU8 = orderType === "limit" ? 1 : 0;
        const maxFills = 10;

        // Build remaining_accounts: maker ATAs needed for fill settlement.
        // One entry per matchable order slot (up to maxFills), NOT deduped by owner.
        // The on-chain engine consumes one remaining_account per fill.
        //   Buy Yes (side=0)  fills Yes asks  → maker's USDC ATA
        //   Sell Yes (side=1) fills USDC bids → maker's Yes ATA
        //                     AND No-backed bids (merge) → maker's USDC ATA
        //   Sell No  (side=2) fills Yes asks (merge) → maker's USDC ATA
        const makerAccounts: AccountMeta[] = [];
        if (orderBookData) {
          const orders = orderBookData.raw.orders;
          let matchableOrders: { order: ActiveOrder; isMerge: boolean }[] = [];

          if (sideU8 === Side.UsdcBid) {
            // Buy Yes: matches against Yes asks at price <= our bid price (ascending)
            matchableOrders = orders
              .filter((o) => o.side === Side.YesAsk && o.priceLevel <= priceU8)
              .sort((a, b) => a.priceLevel - b.priceLevel)
              .map((o) => ({ order: o, isMerge: false }));
          } else if (sideU8 === Side.YesAsk) {
            // Sell Yes: matches against BOTH USDC bids AND No-backed bids
            // Engine walks highest price downward, USDC bids before No-backed bids at each level
            const usdcBids = orders
              .filter((o) => o.side === Side.UsdcBid && o.priceLevel >= priceU8);
            const noBids = orders
              .filter((o) => o.side === Side.NoBackedBid && o.priceLevel <= (100 - priceU8));

            // Interleave: at each price level (highest first), USDC bids then No-backed bids
            const allBids: { order: ActiveOrder; isMerge: boolean }[] = [];
            for (let level = 99; level >= 1; level--) {
              // USDC bids at this level (standard swap)
              for (const o of usdcBids.filter((b) => b.priceLevel === level)) {
                allBids.push({ order: o, isMerge: false });
              }
              // No-backed bids at this level (merge/burn)
              for (const o of noBids.filter((b) => b.priceLevel === level)) {
                allBids.push({ order: o, isMerge: true });
              }
            }
            matchableOrders = allBids;
          } else if (sideU8 === Side.NoBackedBid) {
            // Sell No: matches against Yes asks where ask_price <= (100 - our_price)
            // Engine walks ascending (lowest ask first)
            const maxYesAsk = 100 - priceU8;
            matchableOrders = orders
              .filter((o) => o.side === Side.YesAsk && o.priceLevel <= maxYesAsk)
              .sort((a, b) => a.priceLevel - b.priceLevel)
              .map((o) => ({ order: o, isMerge: true }));
          }

          // One ATA per matchable order slot (no dedup — engine consumes per fill)
          for (const { order, isMerge } of matchableOrders) {
            if (makerAccounts.length >= maxFills) break;

            let makerAta: PublicKey;
            if (sideU8 === Side.YesAsk && !isMerge) {
              // Standard swap: Sell Yes fills USDC bid → maker receives Yes tokens
              makerAta = getAssociatedTokenAddressSync(yesMint, order.owner);
            } else {
              // All other cases: maker receives USDC
              // - Buy Yes fills Yes ask → maker gets USDC
              // - Sell Yes fills No-backed bid (merge) → maker gets USDC
              // - Sell No fills Yes ask (merge) → maker gets USDC
              makerAta = getAssociatedTokenAddressSync(USDC_MINT, order.owner);
            }
            makerAccounts.push({ pubkey: makerAta, isSigner: false, isWritable: true });
          }
        }

        const placeOrderIx = await program.methods
          .placeOrder(sideU8, priceU8, new BN(quantityLamports!), orderTypeU8, maxFills)
          .accountsPartial({
            user,
            config,
            market: marketPubkey,
            orderBook: orderBookPda,
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
          })
          .remainingAccounts(makerAccounts)
          .instruction();

        tx.add(placeOrderIx);

        const sideLabel = side.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const signature = await sendTransaction(tx, { description: `Place ${sideLabel} Order` });
        if (signature) {
          // Optimistic updates: immediately refetch related queries
          queryClient.invalidateQueries({ queryKey: ["positions"] });
          queryClient.invalidateQueries({ queryKey: ["order-book", marketKey] });
          queryClient.invalidateQueries({ queryKey: ["cost-basis"] });
          onTransactionSuccess?.(signature);
        }
      }
    } catch (err) {
      // Pre-sendTransaction errors (PDA derivation, ATA resolution) won't be
      // caught by useTransaction's internal toast — surface them here.
      const msg = err instanceof Error ? err.message : "Order failed";
      const { toast } = await import("sonner");
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [
    isValid,
    program,
    walletPublicKey,
    submitting,
    marketPubkey,
    marketKey,
    side,
    orderType,
    effectivePrice,
    quantityLamports,
    sendTransaction,
    orderBookData,
    onTransactionSuccess,
    queryClient,
  ]);

  const handleSubmit = useCallback(() => {
    if (isMainnet) {
      setShowConfirmModal(true);
    } else {
      handleSubmitDirect();
    }
  }, [isMainnet, handleSubmitDirect]);

  const handleConfirmMainnet = useCallback(() => {
    setShowConfirmModal(false);
    handleSubmitDirect();
  }, [handleSubmitDirect]);

  const isBuying = side === "buy-yes" || side === "buy-no";

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white/80">Place Order</h3>

      {/* Side selector */}
      <div className="grid grid-cols-4 gap-1 rounded-md border border-white/10 p-0.5 text-xs">
        {(["buy-yes", "buy-no", "sell-yes", "sell-no"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`rounded px-2 py-1.5 transition-colors ${
              side === s
                ? s === "buy-yes" || s === "buy-no"
                  ? s === "buy-yes" ? "bg-yes/20 text-yes" : "bg-no/20 text-no"
                  : "bg-no/20 text-no"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {s === "buy-yes" && "Buy Yes"}
            {s === "buy-no" && "Buy No"}
            {s === "sell-yes" && "Sell Yes"}
            {s === "sell-no" && "Sell No"}
          </button>
        ))}
      </div>

      {/* Order type toggle */}
      <div className="flex rounded-md border border-white/10 text-xs">
        <button
          onClick={() => setOrderType("limit")}
          className={`flex-1 px-3 py-1.5 transition-colors ${
            orderType === "limit"
              ? "bg-accent/20 text-accent"
              : "text-white/50 hover:text-white/80"
          }`}
        >
          Limit
        </button>
        <button
          onClick={() => setOrderType("market")}
          className={`flex-1 px-3 py-1.5 transition-colors ${
            orderType === "market"
              ? "bg-accent/20 text-accent"
              : "text-white/50 hover:text-white/80"
          }`}
        >
          Market
        </button>
      </div>

      {/* Price input (limit only) */}
      {orderType === "limit" && (
        <div>
          <label className="block text-xs text-white/50 mb-1">
            Price (1-99c)
          </label>
          <div className="relative">
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
              placeholder="50"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40">
              c
            </span>
          </div>
        </div>
      )}

      {/* Dollar amount input */}
      <div>
        <label className="block text-xs text-white/50 mb-1">
          Amount ($)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/40">
            $
          </span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={dollarAmount}
            onChange={(e) => setDollarAmount(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-white/5 pl-7 pr-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none"
            placeholder="10.00"
          />
        </div>
        {derivedQuantity !== null && (
          <p className="text-[10px] text-white/40 mt-1">
            ≈ {derivedQuantity.toFixed(derivedQuantity % 1 === 0 ? 0 : 2)} contracts
          </p>
        )}
      </div>

      {/* Cost / payout estimate */}
      {estimatedCost !== null && (
        <div className="rounded-md bg-white/5 px-3 py-2 text-xs space-y-1">
          <div>
            <span className="text-white/50">
              {isBuying ? "Cost" : "Est. Proceeds"}:{" "}
            </span>
            <span className="font-medium text-white">
              ${estimatedCost.toFixed(2)}
            </span>
          </div>
          {isBuying && estimatedPayout !== null && (
            <div>
              <span className="text-white/50">Payout:{" "}</span>
              <span className="font-medium text-white">
                ${estimatedPayout.toFixed(2)} if {side === "buy-yes" ? "Yes" : "No"} wins
              </span>
            </div>
          )}
        </div>
      )}

      {/* Rent disclosure for limit orders */}
      {orderType === "limit" && (
        <div className="text-[10px] text-white/20">
          ~0.002 SOL rent for new token accounts (one-time per market)
        </div>
      )}

      {/* Ticker / strike context */}
      <div className="text-[11px] text-white/40">
        {ticker} @ ${(strikePrice / 1_000_000).toFixed(2)} strike
      </div>

      {/* Market order liquidity warning */}
      {marketOrderWarning && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {marketOrderWarning}
        </div>
      )}

      {/* Position constraint warning */}
      {positionConflict && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {positionConflict}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!isValid || submitting || !!positionConflict || !!marketOrderWarning}
        className={`w-full rounded-md py-2.5 text-sm font-semibold transition-colors ${
          isBuying
            ? side === "buy-yes"
              ? "bg-yes hover:bg-yes-dark disabled:bg-yes/30"
              : "bg-no hover:bg-no-dark disabled:bg-no/30"
            : "bg-no hover:bg-no-dark disabled:bg-no/30"
        } text-white disabled:cursor-not-allowed`}
      >
        {submitting
          ? "Submitting..."
          : `${isBuying ? "Buy" : "Sell"} ${side.includes("yes") ? "Yes" : "No"}`}
      </button>

      {isMainnet && (
        <TradeConfirmationModal
          isOpen={showConfirmModal}
          onConfirm={handleConfirmMainnet}
          onCancel={() => setShowConfirmModal(false)}
          ticker={ticker}
          side={side.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          price={displayPrice ?? 50}
          quantity={derivedQuantity ?? 0}
          estimatedCost={estimatedCost ?? 0}
        />
      )}
    </div>
  );
}
