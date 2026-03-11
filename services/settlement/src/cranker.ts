// ---------------------------------------------------------------------------
// Crank Cancel loop — clears resting orders from settled markets
// ---------------------------------------------------------------------------

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig } from "../../shared/src/pda.js";
import { MarketInfo, tickerFromBytes } from "./settler.js";

const log = createLogger("settlement:cranker");

const MAX_BATCH_SIZE = 32;
const MAX_CRANK_ITERATIONS = 100;

/** Order side constants matching the on-chain enum */
const SIDE_USDC_BID = 0;  // Buy Yes with USDC
const SIDE_YES_ASK = 1;   // Sell Yes
const SIDE_NO_BID = 2;    // Sell No (No-backed bid)

interface OrderSlotData {
  owner: PublicKey;
  orderId: BN;
  quantity: BN;
  side: number;
  isActive: number;
}

interface PriceLevelData {
  orders: OrderSlotData[];
  count: number;
}

/**
 * Scan the order book account and return all active orders.
 */
function extractActiveOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderBookAccount: any,
): OrderSlotData[] {
  const activeOrders: OrderSlotData[] = [];

  for (const level of orderBookAccount.levels) {
    for (const slot of level.orders) {
      // isActive is stored as u8; 1 = active
      const active = typeof slot.isActive === "number" ? slot.isActive : Number(slot.isActive);
      if (active === 1) {
        activeOrders.push({
          owner: slot.owner,
          orderId: slot.orderId,
          quantity: slot.quantity,
          side: typeof slot.side === "number" ? slot.side : Number(slot.side),
          isActive: active,
        });
      }
    }
  }

  return activeOrders;
}

/**
 * For a batch of orders, derive the remaining_accounts array.
 * Each cancelled order needs the owner's token ATA for the appropriate mint:
 *   - side 0 (USDC bid) -> owner's USDC ATA (escrow_vault refunds USDC)
 *   - side 1 (Yes ask)   -> owner's Yes ATA (yes_escrow refunds Yes tokens)
 *   - side 2 (No bid)    -> owner's No ATA (no_escrow refunds No tokens)
 */
function buildRemainingAccounts(
  orders: OrderSlotData[],
  usdcMint: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return orders.map((order) => {
    let mint: PublicKey;
    switch (order.side) {
      case SIDE_USDC_BID:
        mint = usdcMint;
        break;
      case SIDE_YES_ASK:
        mint = yesMint;
        break;
      case SIDE_NO_BID:
        mint = noMint;
        break;
      default:
        throw new Error(`Unknown order side: ${order.side}`);
    }

    const ata = getAssociatedTokenAddressSync(mint, order.owner, true);
    return {
      pubkey: ata,
      isSigner: false,
      isWritable: true,
    };
  });
}

/**
 * Crank cancel all resting orders for a single settled market.
 * Sends batch_size=32 per instruction until the book is empty.
 * Returns the total number of orders cancelled.
 */
async function crankMarket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  market: MarketInfo,
  usdcMint: PublicKey,
): Promise<number> {
  const ticker = tickerFromBytes(market.account.ticker);
  const [configPda] = findGlobalConfig();
  let totalCancelled = 0;

  for (let iteration = 0; iteration < MAX_CRANK_ITERATIONS; iteration++) {
    // Fetch fresh order book state each iteration
    const orderBookAccount = await program.account.orderBook.fetch(
      market.account.orderBook,
    );

    const activeOrders = extractActiveOrders(orderBookAccount);
    if (activeOrders.length === 0) {
      log.info(`Order book for ${ticker} is clear (${totalCancelled} total cancelled)`);
      break;
    }

    // Take up to MAX_BATCH_SIZE orders for this crank call
    const batch = activeOrders.slice(0, MAX_BATCH_SIZE);
    const batchSize = batch.length;

    const remainingAccounts = buildRemainingAccounts(
      batch,
      usdcMint,
      market.account.yesMint,
      market.account.noMint,
    );

    log.info(`Cranking ${batchSize} orders for ${ticker} (${activeOrders.length} remaining, iteration ${iteration + 1})`, {
      market: market.publicKey.toBase58(),
    });

    try {
      await program.methods
        .crankCancel(batchSize)
        .accounts({
          caller: program.provider.publicKey!,
          config: configPda,
          market: market.publicKey,
          orderBook: market.account.orderBook,
          escrowVault: market.account.escrowVault,
          yesEscrow: market.account.yesEscrow,
          noEscrow: market.account.noEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

      totalCancelled += batchSize;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Crank cancel failed for ${ticker}: ${errMsg}`, {
        market: market.publicKey.toBase58(),
        batchSize,
        totalCancelledSoFar: totalCancelled,
      });
      throw err;
    }

    if (iteration === MAX_CRANK_ITERATIONS - 1) {
      log.error(`Crank cancel hit max iterations (${MAX_CRANK_ITERATIONS}) for ${ticker}`, {
        market: market.publicKey.toBase58(),
        totalCancelled,
      });
    }
  }

  return totalCancelled;
}

/**
 * Crank cancel all resting orders across all settled markets.
 */
export async function crankCancelAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  markets: MarketInfo[],
  usdcMint: PublicKey,
): Promise<{ market: string; cancelled: number; error?: string }[]> {
  const results: { market: string; cancelled: number; error?: string }[] = [];

  for (const market of markets) {
    const ticker = tickerFromBytes(market.account.ticker);
    try {
      const cancelled = await crankMarket(program, market, usdcMint);
      results.push({ market: ticker, cancelled });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.critical(`Crank cancel failed for ${ticker}: ${errMsg}`, {
        market: market.publicKey.toBase58(),
      });
      results.push({ market: ticker, cancelled: 0, error: errMsg });
    }
  }

  return results;
}
