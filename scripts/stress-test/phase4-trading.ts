/**
 * phase4-trading.ts — Order placement across 14 trading markets.
 *
 * Round 1: Resting orders (bids + asks, no fills)
 * Round 2: Crossing fills (sequential with fresh orderbook reads)
 * Round 3: Pause/unpause exercise (verify market resumes after unpause)
 * Round 4: Cancels (cancel resting orders from Round 1)
 * Round 5: Market orders (sweep remaining resting bids)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  DEFAULTS,
  type PhaseStats,
  newPhaseStats,
  finishPhaseStats,
} from "./config";
import {
  findGlobalConfig,
  findFeeVault,
  sendTx,
  parseOrderBook,
  type MarketAddresses,
  type ParsedOrder,
} from "./helpers";
import { buildPlaceOrderIx, buildCancelOrderIx, buildPauseIx, buildUnpauseIx } from "./instructions";

// Side constants
const SIDE_USDC_BID = 0;
const SIDE_YES_ASK = 1;

// Order type constants
const ORDER_TYPE_MARKET = 0;
const ORDER_TYPE_LIMIT = 1;

/** A deferred order — a function that returns a promise when called. */
interface DeferredOrder {
  (): Promise<boolean>;
}

/**
 * Place a single order and return success/failure.
 */
async function placeOrder(
  connection: Connection,
  configPda: PublicKey,
  wallet: Keypair,
  m: MarketAddresses,
  usdcMint: PublicKey,
  side: number,
  price: number,
  quantity: number,
  orderType: number,
  maxFills: number,
  stats: PhaseStats,
  makerAccounts?: PublicKey[],
): Promise<boolean> {
  stats.attempted++;
  try {
    const ix = buildPlaceOrderIx({
      user: wallet.publicKey,
      config: configPda,
      market: m.market,
      orderBook: m.orderBook,
      usdcVault: m.usdcVault,
      escrowVault: m.escrowVault,
      yesEscrow: m.yesEscrow,
      noEscrow: m.noEscrow,
      yesMint: m.yesMint,
      noMint: m.noMint,
      userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
      userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
      userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
      feeVault: findFeeVault()[0],
      side,
      price,
      quantity: new BN(quantity),
      orderType,
      maxFills,
      makerAccounts,
    });
    await sendTx(connection, new Transaction().add(ix), [wallet]);
    stats.succeeded++;
    return true;
  } catch (e: any) {
    stats.failed++;
    const msg = e.message?.slice(0, 100) ?? String(e);
    // Only log non-common errors
    if (!msg.includes("OrderBookFull") && !msg.includes("InsufficientBalance") && !msg.includes("already been processed")) {
      stats.errors.push(`order ${m.def.ticker} s=${side} p=${price}: ${msg}`);
    }
    return false;
  }
}

/**
 * Run deferred tasks in batches of `concurrency`.
 * Unlike collecting pre-started promises, this actually limits concurrency.
 */
async function runBatched(tasks: DeferredOrder[], concurrency: number): Promise<void> {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batchSlice = tasks.slice(i, i + concurrency);
    await Promise.all(batchSlice.map((fn) => fn()));
  }
}

/**
 * Compute the maker ATAs needed as remaining_accounts for a crossing order.
 *
 * Matching rules:
 *   - Incoming USDC BID (side=0) at price P crosses resting Yes asks (side=1) at price <= P.
 *     Maker receives USDC → remaining_account = maker's USDC ATA.
 *   - Incoming Yes ASK (side=1) at price P crosses resting USDC bids (side=0) at price >= P.
 *     Maker receives Yes tokens → remaining_account = maker's Yes ATA.
 *
 * Returns up to `maxFills` PublicKeys, sorted best-price-first.
 */
function getMatchingMakerAccounts(
  orders: ParsedOrder[],
  incomingSide: number,
  incomingPrice: number,
  maxFills: number,
  usdcMint: PublicKey,
  yesMint: PublicKey,
): PublicKey[] {
  let candidates: ParsedOrder[];

  if (incomingSide === SIDE_USDC_BID) {
    // Incoming USDC bid crosses resting Yes asks at price <= incomingPrice.
    // Best price for taker = lowest ask first.
    candidates = orders
      .filter((o) => o.side === SIDE_YES_ASK && o.priceLevel <= incomingPrice)
      .sort((a, b) => a.priceLevel - b.priceLevel);
  } else {
    // Incoming Yes ask crosses resting USDC bids at price >= incomingPrice.
    // Best price for taker = highest bid first.
    candidates = orders
      .filter((o) => o.side === SIDE_USDC_BID && o.priceLevel >= incomingPrice)
      .sort((a, b) => b.priceLevel - a.priceLevel);
  }

  return candidates.slice(0, maxFills).map((o) => {
    if (incomingSide === SIDE_USDC_BID) {
      // Maker is a Yes seller; they receive USDC.
      return getAssociatedTokenAddressSync(usdcMint, o.owner);
    } else {
      // Maker is a USDC bidder; they receive Yes tokens.
      return getAssociatedTokenAddressSync(yesMint, o.owner);
    }
  });
}

/**
 * Phase 4: Execute trading rounds across all trading markets.
 */
export async function phase4Trading(
  connection: Connection,
  admin: Keypair,
  wallets: Keypair[],
  usdcMint: PublicKey,
  markets: MarketAddresses[],
): Promise<{ stats: PhaseStats }> {
  const tradingMarkets = markets.filter((m) => !m.def.isLifecycle);
  console.log(`\n[Phase 4] Trading across ${tradingMarkets.length} markets with ${wallets.length} wallets...`);
  const stats = newPhaseStats("Trading");
  const [configPda] = findGlobalConfig();

  const qty = DEFAULTS.ORDER_QUANTITY;
  const halfWallets = Math.floor(wallets.length / 2);
  const bidWallets = wallets.slice(0, halfWallets);
  const askWallets = wallets.slice(halfWallets);

  let totalOrders = 0;
  // Moderate concurrency — skipPreflight lets the validator schedule write-locked
  // txns sequentially within a slot instead of failing preflight simulation.
  const concurrency = 10;

  for (let mi = 0; mi < tradingMarkets.length; mi++) {
    const m = tradingMarkets[mi];
    console.log(`  Market ${mi + 1}/${tradingMarkets.length}: ${m.def.ticker} $${Number(m.def.strikeLamports) / 1_000_000}`);

    // ── Round 1: Seed the book with resting orders ──
    // Ask wallets place Yes asks at prices 40-55 (these rest on the book)
    // Bid wallets place USDC bids at prices 35-50 (rest below asks)
    const round1Asks = askWallets.slice(0, 20);
    const round1Bids = bidWallets.slice(0, 20);

    const r1Tasks: DeferredOrder[] = [];
    for (let i = 0; i < round1Asks.length; i++) {
      const price = 40 + Math.floor(i * 16 / round1Asks.length); // spread 40-55
      const w = round1Asks[i];
      r1Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_YES_ASK, price, qty, ORDER_TYPE_LIMIT, 0, stats));
    }
    for (let i = 0; i < round1Bids.length; i++) {
      const price = 35 + Math.floor(i * 16 / round1Bids.length); // spread 35-50
      const w = round1Bids[i];
      r1Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_USDC_BID, price, qty, ORDER_TYPE_LIMIT, 0, stats));
    }
    await runBatched(r1Tasks, concurrency);
    totalOrders += r1Tasks.length;

    // ── Round 2: Crossing fills ──
    // Each crossing order is processed sequentially with a fresh orderbook read
    // to ensure maker accounts in remaining_accounts match the actual fill order.
    const r2Bids = bidWallets.slice(20, 35);
    const r2Asks = askWallets.slice(20, 35);

    // Crossing bids (high bids that cross existing asks at 40-55)
    for (let i = 0; i < r2Bids.length; i++) {
      const price = 55 + Math.floor(i * 11 / r2Bids.length);
      const w = r2Bids[i];
      const obData = await connection.getAccountInfo(m.orderBook);
      const orders = obData ? parseOrderBook(Buffer.from(obData.data)) : [];
      const makerAccounts = getMatchingMakerAccounts(orders, SIDE_USDC_BID, price, 5, usdcMint, m.yesMint);
      await placeOrder(connection, configPda, w, m, usdcMint, SIDE_USDC_BID, price, qty, ORDER_TYPE_LIMIT, 5, stats, makerAccounts);
      totalOrders++;
    }
    // Crossing asks (low asks that cross existing bids at 35-50)
    for (let i = 0; i < r2Asks.length; i++) {
      const price = 30 + Math.floor(i * 16 / r2Asks.length);
      const w = r2Asks[i];
      const obData = await connection.getAccountInfo(m.orderBook);
      const orders = obData ? parseOrderBook(Buffer.from(obData.data)) : [];
      const makerAccounts = getMatchingMakerAccounts(orders, SIDE_YES_ASK, price, 5, usdcMint, m.yesMint);
      await placeOrder(connection, configPda, w, m, usdcMint, SIDE_YES_ASK, price, qty, ORDER_TYPE_LIMIT, 5, stats, makerAccounts);
      totalOrders++;
    }

    // ── Round 3: Pause/unpause ──
    // Exercise pause and unpause instructions on the first market only (once per run).
    if (mi === 0) {
      // Pause market
      stats.attempted++;
      try {
        const pauseIx = buildPauseIx({ admin: admin.publicKey, config: configPda, market: m.market });
        await sendTx(connection, new Transaction().add(pauseIx), [admin]);
        stats.succeeded++;
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`pause: ${e.message?.slice(0, 100)}`);
      }
      // Unpause market (so trading can continue)
      stats.attempted++;
      try {
        const unpauseIx = buildUnpauseIx({ admin: admin.publicKey, config: configPda, market: m.market });
        await sendTx(connection, new Transaction().add(unpauseIx), [admin]);
        stats.succeeded++;
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`unpause: ${e.message?.slice(0, 100)}`);
      }
      totalOrders += 2;
    }

    // ── Round 4: Cancels ──
    // Read the order book to find actual order IDs to cancel
    const obAcct = await connection.getAccountInfo(m.orderBook);
    if (obAcct) {
      const orders = parseOrderBook(Buffer.from(obAcct.data));
      // Cancel up to 5 orders that belong to our bid wallets
      const cancelWalletPubkeys = new Set(bidWallets.slice(0, 20).map((w) => w.publicKey.toBase58()));
      const cancellableOrders = orders.filter((o) => cancelWalletPubkeys.has(o.owner.toBase58()));
      const toCancelCount = Math.min(5, cancellableOrders.length);

      for (let ci = 0; ci < toCancelCount; ci++) {
        const order = cancellableOrders[ci];
        const wallet = bidWallets.slice(0, 20).find((w) => w.publicKey.toBase58() === order.owner.toBase58());
        if (!wallet) continue;

        stats.attempted++;
        try {
          const ix = buildCancelOrderIx({
            user: wallet.publicKey,
            config: configPda,
            market: m.market,
            orderBook: m.orderBook,
            escrowVault: m.escrowVault,
            yesEscrow: m.yesEscrow,
            noEscrow: m.noEscrow,
            userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
            userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
            userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
            price: order.priceLevel,
            orderId: new BN(order.orderId.toString()),
          });
          await sendTx(connection, new Transaction().add(ix), [wallet]);
          stats.succeeded++;
        } catch (e: any) {
          stats.failed++;
          if (!e.message?.includes("OrderNotFound")) {
            stats.errors.push(`cancel: ${e.message?.slice(0, 100)}`);
          }
        }
        totalOrders++;
      }
    }

    // ── Round 5: Market orders ──
    // Market sell orders (Yes ASK at price=1) sweep all resting USDC bids.
    // Each order gets a fresh orderbook read; skip if no resting bids remain.
    const marketOrderWallets = askWallets.slice(35, 45);
    for (let i = 0; i < marketOrderWallets.length; i++) {
      const w = marketOrderWallets[i];
      const obData = await connection.getAccountInfo(m.orderBook);
      const orders = obData ? parseOrderBook(Buffer.from(obData.data)) : [];
      const restingBids = orders.filter((o) => o.side === SIDE_USDC_BID);
      if (restingBids.length === 0) break; // Book is empty — no point submitting more market sells
      const makerAccounts = getMatchingMakerAccounts(orders, SIDE_YES_ASK, 1, 10, usdcMint, m.yesMint);
      await placeOrder(connection, configPda, w, m, usdcMint, SIDE_YES_ASK, 1, qty, ORDER_TYPE_MARKET, 10, stats, makerAccounts);
      totalOrders++;
    }
  }

  console.log(`  Total orders: ${totalOrders}, succeeded: ${stats.succeeded}, failed: ${stats.failed}`);
  return { stats: finishPhaseStats(stats) };
}
