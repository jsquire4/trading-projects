/**
 * phase5-settlement.ts — Settle lifecycle markets + redemption exercises.
 *
 * Steps:
 * 1. Wait for lifecycle markets to close
 * 2. Oracle settle first 6 lifecycle markets (update_price + settle_market inline)
 * 3. admin_settle on last lifecycle market (fallback to oracle if < 1h post-close)
 * 4. admin_override_settlement on one settled market (flip outcome, then re-settle)
 * 5. Winner redemption (mode=1 Yes, mode=2 No) on lifecycle markets
 * 6. Pair burn (mode=0) on trading markets
 * 7. Verify settlement and vault invariants
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
  buildAdminOverrideIx,
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

  // ── Step 1: Wait for lifecycle markets to pass their close time ──
  const oracleSettleMarkets = lifecycleMarkets.slice(0, -1);
  const adminSettleMarket = lifecycleMarkets[lifecycleMarkets.length - 1];

  const marketAcct = await connection.getAccountInfo(lifecycleMarkets[0]?.market);
  if (marketAcct) {
    const closeUnix = Number(Buffer.from(marketAcct.data).readBigInt64LE(304));
    const nowSec = Math.floor(Date.now() / 1000);
    const waitSec = closeUnix - nowSec + 2;
    if (waitSec > 0) {
      console.log(`  Waiting ${waitSec}s for lifecycle markets to close...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }

  // ── Step 2: Update oracle + settle_market for each lifecycle market ──
  // Oracle prices are updated immediately before each settlement to avoid
  // staleness (settlement_staleness = 120s).
  // After settling the first market, immediately exercise admin_override_settlement
  // before the override window expires (5s in stress-test builds).
  console.log(`  Settling ${oracleSettleMarkets.length} lifecycle markets via oracle (settle_market)...`);
  let overrideExercised = false;
  for (const m of oracleSettleMarkets) {
    const ticker = m.def.ticker as Ticker;
    const price = SETTLEMENT_PRICES[ticker];

    // Update oracle price (fresh timestamp guarantees < 120s staleness)
    stats.attempted++;
    try {
      const ts = Math.floor(Date.now() / 1000) - 2;
      const updateIx = buildUpdatePriceIx({
        authority: admin.publicKey,
        priceFeed: m.oracleFeed,
        price: new BN(price.toString()),
        confidence: new BN(Math.floor(Number(price) * 40 / 10_000)),  // 0.4% of price (under 0.5% cap)
        timestamp: new BN(ts),
      });
      await sendTx(connection, new Transaction().add(updateIx), [admin]);
      stats.succeeded++;
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`update_price ${ticker}: ${e.message?.slice(0, 120)}`);
      console.error(`    ERROR update_price ${ticker}: ${e.message?.slice(0, 120)}`);
    }

    // Settle
    let settled = false;
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
      settled = true;
      console.log(`    Settled (oracle): ${ticker} $${Number(m.def.strikeLamports) / 1_000_000}`);
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`settle_market ${ticker}: ${e.message?.slice(0, 120)}`);
      console.error(`    ERROR settle ${ticker}: ${e.message?.slice(0, 120)}`);
    }

    // Exercise admin_override_settlement immediately after first settle
    // (must happen before override window expires)
    if (settled && !overrideExercised) {
      overrideExercised = true;
      const originalState = await readMarketState(connection, m.market);
      const originalOutcome = originalState?.outcome ?? 0;
      const flippedPrice = originalOutcome === 1
        ? m.def.strikeLamports - 1n
        : m.def.strikeLamports + 1n;

      stats.attempted++;
      try {
        const ix = buildAdminOverrideIx({
          admin: admin.publicKey,
          config: configPda,
          market: m.market,
          newSettlementPrice: new BN(flippedPrice.toString()),
        });
        await sendTx(connection, new Transaction().add(ix), [admin]);
        stats.succeeded++;
        const newState = await readMarketState(connection, m.market);
        console.log(`    Override ${ticker}: outcome ${originalOutcome} → ${newState?.outcome}`);

        // Restore original outcome so redemptions work correctly
        stats.attempted++;
        const restoreIx = buildAdminOverrideIx({
          admin: admin.publicKey,
          config: configPda,
          market: m.market,
          newSettlementPrice: new BN(price.toString()),
        });
        await sendTx(connection, new Transaction().add(restoreIx), [admin]);
        stats.succeeded++;
        console.log(`    Restored ${ticker} to original outcome`);
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`override ${ticker}: ${e.message?.slice(0, 200)}`);
        console.error(`    ERROR override ${ticker}: ${e.message?.slice(0, 200)}`);
      }
    }
  }

  // ── Step 3: admin_settle on reserved last lifecycle market ──
  // admin_settle requires clock >= market_close + ADMIN_SETTLE_DELAY_SECS.
  // With stress-test feature: 5s delay. Production: 3600s (use --resume).
  // Wait for the delay to pass before attempting.
  if (adminSettleMarket) {
    const marketAcct2 = await connection.getAccountInfo(adminSettleMarket.market);
    if (marketAcct2) {
      const closeUnix = Number(Buffer.from(marketAcct2.data).readBigInt64LE(304));
      // Wait up to 30s for admin_settle delay; beyond that, skip wait and fall back to oracle
      const nowSec2 = Math.floor(Date.now() / 1000);
      const adminWait = closeUnix + 5 - nowSec2 + 1; // 5s = stress-test delay
      if (adminWait > 0 && adminWait <= 30) {
        console.log(`  Waiting ${adminWait}s for admin_settle delay...`);
        await new Promise((r) => setTimeout(r, adminWait * 1000));
      }
    }
    const ticker = adminSettleMarket.def.ticker as Ticker;
    console.log(`  Attempting admin_settle on ${ticker}...`);
    let adminSettled = false;
    stats.attempted++;
    try {
      const ix = buildAdminSettleIx({
        admin: admin.publicKey,
        config: configPda,
        market: adminSettleMarket.market,
        settlementPrice: new BN(SETTLEMENT_PRICES[ticker].toString()),
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
      stats.succeeded++;
      adminSettled = true;
      console.log(`    admin_settle succeeded on ${ticker}`);
    } catch (e: any) {
      stats.failed++;
      console.log(`    admin_settle not available yet (too early). Falling back to oracle settle.`);
    }
    // Fall back to oracle settle if admin_settle failed
    if (!adminSettled) {
      // Fresh oracle update before settlement
      const settlePrice = SETTLEMENT_PRICES[ticker];
      stats.attempted++;
      try {
        const ts = Math.floor(Date.now() / 1000) - 2;
        const updateIx = buildUpdatePriceIx({
          authority: admin.publicKey,
          priceFeed: adminSettleMarket.oracleFeed,
          price: new BN(settlePrice.toString()),
          confidence: new BN(Math.floor(Number(settlePrice) * 40 / 10_000)),  // 0.4% of price (under 0.5% cap)
          timestamp: new BN(ts),
        });
        await sendTx(connection, new Transaction().add(updateIx), [admin]);
        stats.succeeded++;
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`update_price ${ticker}: ${e.message?.slice(0, 120)}`);
      }

      stats.attempted++;
      try {
        const ix = buildSettleMarketIx({
          caller: admin.publicKey,
          config: configPda,
          market: adminSettleMarket.market,
          oracleFeed: adminSettleMarket.oracleFeed,
        });
        await sendTx(connection, new Transaction().add(ix), [admin]);
        stats.succeeded++;
        console.log(`    Settled (oracle fallback): ${ticker}`);
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`settle_market ${ticker}: ${e.message?.slice(0, 120)}`);
        console.error(`    ERROR settle ${ticker}: ${e.message?.slice(0, 120)}`);
      }
    }
  }

  // ── Step 4: Wait for override window to pass ──
  // Winner redemption requires clock >= override_deadline.
  // With stress-test feature: 5s. Production: 3600s (use --resume).
  const firstLifecycle = lifecycleMarkets[0];
  if (firstLifecycle) {
    const state = await readMarketState(connection, firstLifecycle.market);
    if (state?.isSettled) {
      const overrideDeadline = Number(state.overrideDeadline);
      const nowSec = Math.floor(Date.now() / 1000);
      const waitSec = overrideDeadline - nowSec + 1;
      if (waitSec > 0 && waitSec <= 30) {
        console.log(`  Waiting ${waitSec}s for override window to pass...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      } else if (waitSec > 30) {
        console.log(`  Override window expires in ${waitSec}s (use --resume after it passes)`);
      }
    }
  }

  // ── Step 5: Winner redemption on lifecycle markets ──
  // 5 ask wallets hold Yes+No tokens on lifecycle markets from Phase 3.
  // After settlement + override window, winning tokens can be redeemed for USDC.
  const halfWallets = Math.floor(wallets.length / 2);
  const lifecycleRedeemWallets = wallets.slice(halfWallets, halfWallets + 5);
  let winnerRedeems = 0;
  console.log(`  Winner redemption on ${lifecycleMarkets.length} lifecycle markets (${lifecycleRedeemWallets.length} wallets)...`);

  for (const wallet of lifecycleRedeemWallets) {
    for (const m of lifecycleMarkets) {
      const state = await readMarketState(connection, m.market);
      if (!state?.isSettled) continue;

      // Mode 1 = winner redemption (handles both Yes/No outcomes internally).
      // On-chain only supports mode 0 (pair burn) and mode 1 (winner redeem).
      const mode = 1;

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
          mode,
          quantity: new BN(1_000_000), // 1 token
        });
        await sendTx(connection, new Transaction().add(ix), [wallet]);
        stats.succeeded++;
        winnerRedeems++;
      } catch (e: any) {
        stats.failed++;
        if (!e.message?.includes("RedemptionBlockedOverride") && !e.message?.includes("InsufficientBalance")) {
          stats.errors.push(`redeem_m${mode} ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
        }
      }
    }
  }
  const redeemTotal = lifecycleRedeemWallets.length * lifecycleMarkets.length;
  console.log(`  Winner redeems: ${winnerRedeems}/${redeemTotal}`);

  // ── Step 6: Pair burn (redeem mode=0) on trading markets ──
  // Use ask wallets (second half) who hold Yes+No tokens from minting.
  const redeemWallets = wallets.slice(halfWallets, halfWallets + 5);
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
  console.log(`  Pair burns (trading): ${pairBurnSucceeded} succeeded, ${pairBurnFailed} failed`);

  // ── Step 7: Pair burn remaining lifecycle tokens ──
  // After winner redeem (1 token), each wallet has 9M winning + 10M losing.
  // Pair burn 9M to reduce to 0 winning + 1M losing (enables partial close in Phase 6).
  const lcPairBurnQty = new BN(DEFAULTS.PAIRS_PER_MARKET - 1_000_000); // 9 tokens
  let lcPairBurns = 0;
  console.log(`  Pair-burning remaining lifecycle tokens (${lifecycleRedeemWallets.length} wallets × ${lifecycleMarkets.length} markets)...`);
  for (const wallet of lifecycleRedeemWallets) {
    for (const m of lifecycleMarkets) {
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
          quantity: lcPairBurnQty,
        });
        await sendTx(connection, new Transaction().add(ix), [wallet]);
        stats.succeeded++;
        lcPairBurns++;
      } catch (e: any) {
        stats.failed++;
        if (!e.message?.includes("InsufficientBalance")) {
          stats.errors.push(`lc_pair_burn ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
        }
      }
    }
  }
  console.log(`  Lifecycle pair burns: ${lcPairBurns}/${lifecycleRedeemWallets.length * lifecycleMarkets.length}`);

  // ── Step 8: Verify settlement ──
  let settledCount = 0;
  for (const m of lifecycleMarkets) {
    const state = await readMarketState(connection, m.market);
    if (state?.isSettled) settledCount++;
  }
  console.log(`  Verification: ${settledCount}/${lifecycleMarkets.length} lifecycle markets settled`);

  // ── Step 9: Verify vault invariants on trading markets ──
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
