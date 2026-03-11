/**
 * phase5-settlement.ts — Settle lifecycle markets + pair-burn on trading markets.
 *
 * - settle_market (oracle-based) on 3 lifecycle markets
 * - admin_settle on 4 lifecycle markets
 * - Pair burn (redeem mode=0) on trading markets to demonstrate redemption
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import BN from "bn.js";
import {
  DEFAULTS,
  SETTLEMENT_PRICES,
  type Ticker,
  type PhaseStats,
  newPhaseStats,
  finishPhaseStats,
} from "./config";
import {
  findGlobalConfig,
  sendTx,
  readMarketState,
  readVaultBalance,
  type MarketAddresses,
} from "./helpers";
import {
  buildSettleMarketIx,
  buildAdminSettleIx,
  buildRedeemIx,
  buildUpdatePriceIx,
} from "./instructions";

/**
 * Phase 5: Settlement + Redemption.
 * Returns stats and vault violation count.
 */
export async function phase5Settlement(
  connection: Connection,
  admin: Keypair,
  wallets: Keypair[],
  usdcMint: PublicKey,
  markets: MarketAddresses[],
): Promise<{ stats: PhaseStats; vaultViolations: number }> {
  console.log("\n[Phase 5] Settlement + Redemption...");
  const stats = newPhaseStats("Settlement + Redeem");
  const [configPda] = findGlobalConfig();

  const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);
  const tradingMarkets = markets.filter((m) => !m.def.isLifecycle);

  // ── Step 1: Update oracle prices to be fresh ──
  console.log("  Updating oracle prices for settlement...");
  for (const m of lifecycleMarkets) {
    stats.attempted++;
    try {
      const ticker = m.def.ticker as Ticker;
      const price = SETTLEMENT_PRICES[ticker];
      const now = Math.floor(Date.now() / 1000);
      const ix = buildUpdatePriceIx({
        authority: admin.publicKey,
        priceFeed: m.oracleFeed,
        price: new BN(price.toString()),
        confidence: new BN(1_000_000),
        timestamp: new BN(now),
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`update_price ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
    }
  }

  // ── Step 2: settle_market (oracle-based) on first 3 lifecycle markets ──
  console.log("  Settling 3 lifecycle markets via oracle (settle_market)...");
  for (let i = 0; i < Math.min(3, lifecycleMarkets.length); i++) {
    const m = lifecycleMarkets[i];
    stats.attempted++;
    try {
      const ix = buildSettleMarketIx({
        caller: admin.publicKey,
        config: configPda,
        market: m.market,
        oracleFeed: m.oracleFeed,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      console.log(`    Settled (oracle): ${m.def.ticker} $${Number(m.def.strikeLamports) / 1_000_000}`);
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`settle_market ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
      console.error(`    ERROR settle ${m.def.ticker}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Step 3: admin_settle on remaining 4 lifecycle markets ──
  console.log("  Settling 4 lifecycle markets via admin (admin_settle)...");
  for (let i = 3; i < lifecycleMarkets.length; i++) {
    const m = lifecycleMarkets[i];
    const ticker = m.def.ticker as Ticker;
    stats.attempted++;
    try {
      const ix = buildAdminSettleIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        settlementPrice: new BN(SETTLEMENT_PRICES[ticker].toString()),
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      console.log(`    Settled (admin): ${m.def.ticker} $${Number(m.def.strikeLamports) / 1_000_000}`);
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`admin_settle ${m.def.ticker}: ${e.message?.slice(0, 120)}`);
      console.error(`    ERROR admin_settle ${m.def.ticker}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Step 4: Pair burn (redeem mode=0) on trading markets ──
  // Each wallet pair-burns a portion of their tokens to demonstrate the redeem instruction.
  const redeemWallets = wallets.slice(0, 5);
  const pairBurnQty = new BN(1_000_000); // 1 token pair burn
  console.log(`  Pair-burning 1 token per wallet on ${tradingMarkets.length} trading markets (${redeemWallets.length} wallets)...`);

  let pairBurnSucceeded = 0;
  let pairBurnFailed = 0;
  for (const wallet of redeemWallets) {
    for (const m of tradingMarkets) {
      stats.attempted++;
      try {
        const ix = buildRedeemIx({
          user: wallet.publicKey,
          config: configPda,
          market: m.market,
          yesMint: m.yesMint,
          noMint: m.noMint,
          usdcVault: m.usdcVault,
          userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
          userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
          userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
          mode: 0,  // pair burn
          quantity: pairBurnQty,
        });
        await sendTx(connection, new Transaction().add(ix), [wallet]);
        stats.succeeded++;
        pairBurnSucceeded++;
      } catch (e: any) {
        stats.failed++;
        pairBurnFailed++;
        if (!e.message?.includes("InsufficientBalance")) {
          stats.errors.push(`redeem ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
        }
      }
    }
  }
  console.log(`  Pair burns: ${pairBurnSucceeded} succeeded, ${pairBurnFailed} failed`);

  // ── Step 5: Verify settlement ──
  let settledCount = 0;
  for (const m of lifecycleMarkets) {
    const state = await readMarketState(connection, m.market);
    if (state?.isSettled) settledCount++;
  }
  console.log(`  Verification: ${settledCount}/${lifecycleMarkets.length} lifecycle markets settled`);

  // ── Step 6: Verify vault invariants on trading markets ──
  // The invariant is: vault + escrow >= total_minted - total_redeemed
  // We check vault + escrow + yes_escrow + no_escrow >= net_minted
  let vaultViolations = 0;
  for (const m of tradingMarkets) {
    const state = await readMarketState(connection, m.market);
    if (!state) continue;
    const netMinted = state.totalMinted - state.totalRedeemed;
    if (netMinted <= 0n) continue;

    const vaultBal = await readVaultBalance(connection, m.usdcVault);
    const escrowBal = await readVaultBalance(connection, m.escrowVault);
    const totalLocked = vaultBal + escrowBal;

    if (totalLocked < netMinted) {
      vaultViolations++;
      console.error(`  VAULT VIOLATION: ${m.def.ticker} locked=${totalLocked} < net_minted=${netMinted}`);
    }
  }
  if (vaultViolations === 0) {
    console.log(`  Vault invariant: PASS (all ${tradingMarkets.length} trading markets)`);
  }

  return { stats: finishPhaseStats(stats), vaultViolations };
}
