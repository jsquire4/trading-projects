/**
 * phase4-trading.ts — Parallel order placement across 14 trading markets.
 * Five rounds: resting orders, crossing fills, no-backed bids, cancels, market orders.
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
  sendTx,
  parseOrderBook,
  batch,
  type MarketAddresses,
} from "./helpers";
import { buildPlaceOrderIx, buildCancelOrderIx } from "./instructions";

// Side constants
const SIDE_USDC_BID = 0;
const SIDE_YES_ASK = 1;
const SIDE_NO_BID = 2;

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
      side,
      price,
      quantity: new BN(quantity),
      orderType,
      maxFills,
    });
    await sendTx(connection, new Transaction().add(ix), [wallet]);
    stats.succeeded++;
    return true;
  } catch (e: any) {
    stats.failed++;
    const msg = e.message?.slice(0, 100) ?? String(e);
    // Only log non-common errors
    if (!msg.includes("OrderBookFull") && !msg.includes("InsufficientBalance")) {
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
 * Phase 4: Execute trading rounds across all trading markets.
 */
export async function phase4Trading(
  connection: Connection,
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
  const concurrency = 20;

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
    // Bid wallets place high bids that cross existing asks at 40-55
    // Ask wallets place low asks that cross existing bids at 35-50
    const r2Bids = bidWallets.slice(20, 35);
    const r2Asks = askWallets.slice(20, 35);

    const r2Tasks: DeferredOrder[] = [];
    for (let i = 0; i < r2Bids.length; i++) {
      const price = 55 + Math.floor(i * 11 / r2Bids.length); // 55-65 crosses asks
      const w = r2Bids[i];
      r2Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_USDC_BID, price, qty, ORDER_TYPE_LIMIT, 5, stats));
    }
    for (let i = 0; i < r2Asks.length; i++) {
      const price = 30 + Math.floor(i * 16 / r2Asks.length); // 30-45 crosses bids
      const w = r2Asks[i];
      r2Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_YES_ASK, price, qty, ORDER_TYPE_LIMIT, 5, stats));
    }
    await runBatched(r2Tasks, concurrency);
    totalOrders += r2Tasks.length;

    // ── Round 3: No-backed bids ──
    const noBidWallets = bidWallets.slice(35, 45);
    const r3Tasks: DeferredOrder[] = [];
    for (let i = 0; i < noBidWallets.length; i++) {
      const price = 50 + Math.floor(i * 11 / noBidWallets.length); // 50-60
      const w = noBidWallets[i];
      r3Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_NO_BID, price, qty, ORDER_TYPE_LIMIT, 5, stats));
    }
    await runBatched(r3Tasks, concurrency);
    totalOrders += r3Tasks.length;

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
    // Market sell orders sweep resting bids
    const marketOrderWallets = askWallets.slice(35, 45);
    const r5Tasks: DeferredOrder[] = [];
    for (let i = 0; i < marketOrderWallets.length; i++) {
      const w = marketOrderWallets[i];
      r5Tasks.push(() => placeOrder(connection, configPda, w, m, usdcMint, SIDE_YES_ASK, 1, qty, ORDER_TYPE_MARKET, 10, stats));
    }
    await runBatched(r5Tasks, concurrency);
    totalOrders += r5Tasks.length;
  }

  console.log(`  Total orders: ${totalOrders}, succeeded: ${stats.succeeded}, failed: ${stats.failed}`);
  return { stats: finishPhaseStats(stats) };
}
