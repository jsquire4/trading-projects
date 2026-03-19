// ---------------------------------------------------------------------------
// On-Chain Executor — Places and cancels orders on the Meridian order book
//
// Uses the place_order and cancel_order instructions from the Meridian program.
// Manages the bot's active orders: cancel stale quotes, then place fresh ones.
// ---------------------------------------------------------------------------

import { type Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  findGlobalConfig,
  findOrderBook,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findYesMint,
  findNoMint,
  findUsdcVault,
} from "../../shared/src/pda.js";
import { createLogger } from "../../shared/src/alerting.js";
import type { Meridian } from "../../shared/src/idl/meridian.js";

const log = createLogger("amm-executor");

// Order sides matching on-chain enum:
//   0 = USDC bid (Buy Yes)
//   1 = Yes ask (Sell Yes)
//   2 = No-backed bid (Sell No)
const SIDE_BID = 0;
const SIDE_ASK = 1;

// Order type: 0 = Limit (resting), 1 = IOC
const ORDER_TYPE_LIMIT = 0;

// Max fills per order placement (matching engine passes)
const DEFAULT_MAX_FILLS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketAccounts {
  marketPubkey: PublicKey;
  usdcMint: PublicKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive all the token accounts needed for place_order and cancel_order.
 */
async function deriveOrderAccounts(
  market: PublicKey,
  usdcMint: PublicKey,
  user: PublicKey,
) {
  const [config] = findGlobalConfig();
  const [orderBook] = findOrderBook(market);
  const [usdcVault] = findUsdcVault(market);
  const [escrowVault] = findEscrowVault(market);
  const [yesEscrow] = findYesEscrow(market);
  const [noEscrow] = findNoEscrow(market);
  const [yesMint] = findYesMint(market);
  const [noMint] = findNoMint(market);

  const userUsdcAta = await getAssociatedTokenAddress(usdcMint, user);
  const userYesAta = await getAssociatedTokenAddress(yesMint, user);
  const userNoAta = await getAssociatedTokenAddress(noMint, user);

  return {
    config,
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
  };
}

// ---------------------------------------------------------------------------
// Cancel bot orders
// ---------------------------------------------------------------------------

/**
 * Cancel all active orders owned by the given admin keypair on a market.
 *
 * Reads the order book account, iterates all 99 price levels, and cancels
 * any order whose owner matches the admin pubkey.
 */
export async function cancelBotOrders(
  program: Program<Meridian>,
  marketAccounts: MarketAccounts,
  admin: Keypair,
): Promise<number> {
  const { marketPubkey, usdcMint } = marketAccounts;
  const [orderBookPda] = findOrderBook(marketPubkey);

  // Fetch raw order book bytes and parse with binary parser
  // (Anchor's auto-deserialization doesn't handle the sparse layout correctly)
  const obAccountInfo = await program.provider.connection.getAccountInfo(orderBookPda);
  if (!obAccountInfo) {
    log.warn(`Order book account not found for ${marketPubkey.toBase58()}`);
    return 0;
  }

  const { parseOrderBook } = await import("../../shared/src/order-book.js");
  const activeOrders = parseOrderBook(Buffer.from(obAccountInfo.data));

  const accounts = await deriveOrderAccounts(
    marketPubkey,
    usdcMint,
    admin.publicKey,
  );

  let cancelled = 0;

  // NOTE (M-16): Each cancel_order call below is a separate RPC transaction.
  // Future improvement: batch into versioned transactions with ALTs.

  for (const order of activeOrders) {
    if (!order.owner.equals(admin.publicKey)) continue;

    try {
      await program.methods
        .cancelOrder(order.priceLevel, new BN(order.orderId.toString()))
        .accounts({
          user: admin.publicKey,
          config: accounts.config,
          market: marketPubkey,
          orderBook: accounts.orderBook,
          escrowVault: accounts.escrowVault,
          yesEscrow: accounts.yesEscrow,
          noEscrow: accounts.noEscrow,
          userUsdcAta: accounts.userUsdcAta,
          userYesAta: accounts.userYesAta,
          userNoAta: accounts.userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      cancelled++;
      log.info(`Cancelled order ${order.orderId} at price ${order.priceLevel}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to cancel order ${order.orderId} at price ${order.priceLevel}`, {
        error: msg,
      });
    }
  }

  return cancelled;
}

// ---------------------------------------------------------------------------
// Place quotes
// ---------------------------------------------------------------------------

/**
 * Place a two-sided quote (bid + ask) on a market.
 *
 * Cancels existing bot orders first, then places fresh bid and ask.
 *
 * @param program    Anchor Program handle
 * @param market     Market accounts (pubkey + USDC mint)
 * @param bidPrice   Bid price in cents [1, 99]
 * @param askPrice   Ask price in cents [1, 99]
 * @param quantity   Order size in token lamports
 * @param admin      Bot keypair (signer)
 */
export async function placeQuotes(
  program: Program<Meridian>,
  market: MarketAccounts,
  bidPrice: number,
  askPrice: number,
  quantity: number,
  admin: Keypair,
): Promise<void> {
  // Step 1: Cancel existing bot orders
  const cancelled = await cancelBotOrders(program, market, admin);
  if (cancelled > 0) {
    log.info(`Cancelled ${cancelled} stale orders before requoting`);
  }

  const accounts = await deriveOrderAccounts(
    market.marketPubkey,
    market.usdcMint,
    admin.publicKey,
  );

  // Step 2: Place bid (side=0, Buy Yes with USDC)
  try {
    await program.methods
      .placeOrder(
        SIDE_BID,
        bidPrice,
        new BN(quantity),
        ORDER_TYPE_LIMIT,
        DEFAULT_MAX_FILLS,
      )
      .accounts({
        user: admin.publicKey,
        config: accounts.config,
        market: market.marketPubkey,
        orderBook: accounts.orderBook,
        usdcVault: accounts.usdcVault,
        escrowVault: accounts.escrowVault,
        yesEscrow: accounts.yesEscrow,
        noEscrow: accounts.noEscrow,
        yesMint: accounts.yesMint,
        noMint: accounts.noMint,
        userUsdcAta: accounts.userUsdcAta,
        userYesAta: accounts.userYesAta,
        userNoAta: accounts.userNoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    log.info(`Placed bid at ${bidPrice}c x ${quantity}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to place bid at ${bidPrice}c`, { error: msg });
    throw err;
  }

  // Step 3: Place ask (side=1, Sell Yes)
  try {
    await program.methods
      .placeOrder(
        SIDE_ASK,
        askPrice,
        new BN(quantity),
        ORDER_TYPE_LIMIT,
        DEFAULT_MAX_FILLS,
      )
      .accounts({
        user: admin.publicKey,
        config: accounts.config,
        market: market.marketPubkey,
        orderBook: accounts.orderBook,
        usdcVault: accounts.usdcVault,
        escrowVault: accounts.escrowVault,
        yesEscrow: accounts.yesEscrow,
        noEscrow: accounts.noEscrow,
        yesMint: accounts.yesMint,
        noMint: accounts.noMint,
        userUsdcAta: accounts.userUsdcAta,
        userYesAta: accounts.userYesAta,
        userNoAta: accounts.userNoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    log.info(`Placed ask at ${askPrice}c x ${quantity}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to place ask at ${askPrice}c — attempting to cancel orphaned bid`, { error: msg });

    // Cancel the orphaned bid to avoid one-sided exposure (#2)
    try {
      await cancelBotOrders(program, market, admin);
      log.warn("Cancelled orphaned bid after ask placement failure");
    } catch (cancelErr: unknown) {
      const cancelMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
      log.warn("Failed to cancel orphaned bid after ask failure", { error: cancelMsg });
    }

    throw err;
  }
}
