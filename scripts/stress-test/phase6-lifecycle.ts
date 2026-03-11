/**
 * phase6-lifecycle.ts — Close market, treasury redeem, cleanup.
 *
 * NOTE: close_market requires clock >= override_deadline (settled_at + 1 hour).
 * On a local validator, the clock is real wall-time, so this phase will fail
 * if run immediately after settlement. The script handles this gracefully
 * and reports it as an expected timing constraint, not a bug.
 *
 * To run Phase 6 successfully:
 *   1. Run phases 1-5 first
 *   2. Wait 1+ hour
 *   3. Run with --resume to retry phase 6
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  type PhaseStats,

  newPhaseStats,
  finishPhaseStats,
} from "./config";
import {
  findGlobalConfig,
  findTreasury,
  sendTx,
  readMarketState,
  parseOrderBook,
  type MarketAddresses,
} from "./helpers";
import {
  buildCloseMarketIx,
  buildTreasuryRedeemIx,
  buildCleanupMarketIx,
  buildCrankCancelIx,
} from "./instructions";

/**
 * Phase 6: Market lifecycle closure.
 * Attempts close_market → treasury_redeem → cleanup_market on lifecycle markets.
 */
export async function phase6Lifecycle(
  connection: Connection,
  admin: Keypair,
  wallets: Keypair[],
  usdcMint: PublicKey,
  markets: MarketAddresses[],
): Promise<{ stats: PhaseStats }> {
  console.log("\n[Phase 6] Market lifecycle (close → treasury_redeem → cleanup)...");
  const stats = newPhaseStats("Lifecycle Close");
  const [configPda] = findGlobalConfig();
  const [treasury] = findTreasury();

  const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);
  let overrideWindowActive = false;

  // ── Step 1: Crank cancel any remaining orders on lifecycle markets ──
  console.log("  Cranking cancel on lifecycle markets...");
  for (const m of lifecycleMarkets) {
    const obAcct = await connection.getAccountInfo(m.orderBook);
    if (!obAcct) continue;

    const orders = parseOrderBook(Buffer.from(obAcct.data));
    if (orders.length === 0) continue;

    // Build remaining_accounts: for each order, provide the owner's USDC/Yes/No ATAs
    const makerAccounts: PublicKey[] = [];
    for (const order of orders.slice(0, 32)) { // max batch size = 32
      const ownerUsdcAta = getAssociatedTokenAddressSync(usdcMint, order.owner);
      const ownerYesAta = getAssociatedTokenAddressSync(m.yesMint, order.owner);
      const ownerNoAta = getAssociatedTokenAddressSync(m.noMint, order.owner);
      makerAccounts.push(ownerUsdcAta, ownerYesAta, ownerNoAta);
    }

    stats.attempted++;
    try {
      const ix = buildCrankCancelIx({
        caller: admin.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        batchSize: Math.min(orders.length, 32),
        makerAccounts,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      console.log(`    Cranked ${orders.length} orders on ${m.def.ticker}`);
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`crank_cancel ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
    }
  }

  // ── Step 2: close_market ──
  console.log("  Attempting close_market on lifecycle markets...");
  for (const m of lifecycleMarkets) {
    const state = await readMarketState(connection, m.market);
    if (!state?.isSettled) {
      console.log(`    SKIP ${m.def.ticker}: not settled`);
      continue;
    }

    stats.attempted++;
    try {
      const ix = buildCloseMarketIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        treasury,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      console.log(`    Closed: ${m.def.ticker}`);
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (msg.includes("OverrideActive") || msg.includes("0x1784") || msg.includes("CloseMarketOverrideActive")) {
        if (!overrideWindowActive) {
          overrideWindowActive = true;
          console.log(`    EXPECTED: Override window still active (1h after settlement).`);
          console.log(`    To complete Phase 6, wait 1h then rerun with --resume.`);
        }
        // Don't count this as a failure — it's an expected timing constraint
        stats.attempted--;
      } else {
        stats.failed++;
        stats.errors.push(`close_market ${m.def.ticker}: ${msg.slice(0, 120)}`);
        console.error(`    ERROR close ${m.def.ticker}: ${msg.slice(0, 80)}`);
      }
    }
  }

  // ── Step 3: treasury_redeem (only if partial close succeeded) ──
  // This step depends on close_market having succeeded with partial close
  const closedMarkets: MarketAddresses[] = [];
  for (const m of lifecycleMarkets) {
    const state = await readMarketState(connection, m.market);
    if (state?.isClosed) closedMarkets.push(m);
  }

  if (closedMarkets.length > 0) {
    console.log(`  Treasury redeem on ${closedMarkets.length} closed markets...`);
    // Use ask wallets who minted on lifecycle markets in Phase 3
    const halfWallets = Math.floor(wallets.length / 2);
    const redeemWallets = wallets.slice(halfWallets, halfWallets + 5);
    for (const m of closedMarkets) {
      for (const wallet of redeemWallets) {
        stats.attempted++;
        try {
          const ix = buildTreasuryRedeemIx({
            user: wallet.publicKey,
            config: configPda,
            market: m.market,
            yesMint: m.yesMint,
            noMint: m.noMint,
            treasury,
            userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
            userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
            userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
          });
          await sendTx(connection, new Transaction().add(ix), [wallet]);
          stats.succeeded++;
        } catch (e: any) {
          stats.failed++;
          if (!e.message?.includes("NoTokensToRedeem")) {
            stats.errors.push(`treasury_redeem ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
          }
        }
      }
    }
  }

  // ── Step 4: cleanup_market (only if closed + zero supply) ──
  for (const m of closedMarkets) {
    stats.attempted++;
    try {
      const ix = buildCleanupMarketIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      console.log(`    Cleaned up: ${m.def.ticker}`);
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`cleanup_market ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
    }
  }

  if (overrideWindowActive) {
    console.log("  Phase 6 partially skipped: override window active (expected for immediate runs).");
  }

  return { stats: finishPhaseStats(stats) };
}
