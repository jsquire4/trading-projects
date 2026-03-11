/**
 * phase6-lifecycle.ts — Close market, treasury redeem, cleanup.
 *
 * close_market requires clock >= override_deadline (settled_at + override window).
 * With stress-test feature: 5s window (completes in a single run).
 * Production build: 3600s window (use --resume after 1h).
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
): Promise<{ stats: PhaseStats; closedCount: number }> {
  console.log("\n[Phase 6] Market lifecycle (close → treasury_redeem → cleanup)...");
  const stats = newPhaseStats("Lifecycle Close");
  const [configPda] = findGlobalConfig();
  const [treasury] = findTreasury();

  const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);
  let overrideWindowActive = false;
  let closedCount = 0;

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

  // ── Step 2: Wait for override window, then close_market ──
  // With stress-test feature: override window = 5s. Production: 3600s.
  const firstSettled = lifecycleMarkets[0];
  if (firstSettled) {
    const firstState = await readMarketState(connection, firstSettled.market);
    if (firstState?.isSettled) {
      const deadline = Number(firstState.overrideDeadline);
      const nowSec = Math.floor(Date.now() / 1000);
      const waitSec = deadline - nowSec + 1;
      if (waitSec > 0 && waitSec <= 30) {
        console.log(`  Waiting ${waitSec}s for override window to pass...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      }
    }
  }

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
      closedCount++;
      console.log(`    Closed: ${m.def.ticker}`);
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (msg.includes("OverrideActive") || msg.includes("CloseMarketOverrideActive")) {
        if (!overrideWindowActive) {
          overrideWindowActive = true;
          console.log(`    EXPECTED: Override window still active. Rerun with --resume after it passes.`);
        }
        stats.attempted--;
      } else if (msg.includes("GracePeriod") || msg.includes("CloseMarketGracePeriodActive")) {
        if (!overrideWindowActive) {
          console.log(`    EXPECTED: Grace period active. Rerun with --resume after it passes.`);
        }
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

  return { stats: finishPhaseStats(stats), closedCount };
}
