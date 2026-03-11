/**
 * phase3-mint-pairs.ts — Mint Yes/No token pairs for trading and lifecycle markets.
 *
 * Trading markets: ask wallets (second half) mint pairs for Phase 4 trading.
 *   Bid wallets (first half) get empty ATAs (ConflictingPosition prevention).
 * Lifecycle markets: 5 ask wallets mint pairs so Phase 5 can test post-settlement
 *   redemption (modes 1/2) and Phase 6 can test treasury_redeem.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  DEFAULTS,
  type PhaseStats,
  newPhaseStats,
  finishPhaseStats,
} from "./config";
import { findGlobalConfig, sendTx, batch, type MarketAddresses } from "./helpers";
import { buildMintPairIx } from "./instructions";

/**
 * Phase 3: Ask wallets mint token pairs; bid wallets get empty ATAs.
 *
 * Split mirrors Phase 4: first half = bid wallets, second half = ask wallets.
 * Bid wallets must NOT hold No tokens (ConflictingPosition on USDC bids).
 */
export async function phase3MintPairs(
  connection: Connection,
  wallets: Keypair[],
  usdcMint: PublicKey,
  markets: MarketAddresses[],
): Promise<{ stats: PhaseStats }> {
  const tradingMarkets = markets.filter((m) => !m.def.isLifecycle);
  const halfWallets = Math.floor(wallets.length / 2);
  const bidWallets = wallets.slice(0, halfWallets);
  const askWallets = wallets.slice(halfWallets);

  const mintTotal = askWallets.length * tradingMarkets.length;
  const ataTotal = bidWallets.length * tradingMarkets.length;
  console.log(`\n[Phase 3] Minting ${DEFAULTS.PAIRS_PER_MARKET / 1_000_000} pairs for ${askWallets.length} ask wallets × ${tradingMarkets.length} markets (${mintTotal} mints)...`);
  console.log(`  Creating empty ATAs for ${bidWallets.length} bid wallets × ${tradingMarkets.length} markets (${ataTotal} ATAs)...`);
  const stats = newPhaseStats("Mint Pairs");

  const [configPda] = findGlobalConfig();
  const quantity = new BN(DEFAULTS.PAIRS_PER_MARKET);
  let completed = 0;

  // ── Step 1: Mint pairs for ask wallets ──
  const concurrency = 20;
  const askBatches = batch(askWallets, concurrency);

  for (const wb of askBatches) {
    const promises = wb.map(async (wallet) => {
      for (const m of tradingMarkets) {
        stats.attempted++;
        try {
          const ix = buildMintPairIx({
            user: wallet.publicKey,
            config: configPda,
            market: m.market,
            yesMint: m.yesMint,
            noMint: m.noMint,
            userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
            userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
            userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
            usdcVault: m.usdcVault,
            quantity,
          });
          await sendTx(connection, new Transaction().add(ix), [wallet]);
          stats.succeeded++;
        } catch (e: any) {
          stats.failed++;
          stats.errors.push(`mint ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
        }
        completed++;
        if (completed % 100 === 0) {
          console.log(`  Progress: ${completed}/${mintTotal} mints`);
        }
      }
    });
    await Promise.all(promises);
  }
  console.log(`  Minted: ${stats.succeeded}/${stats.attempted} (${stats.failed} failed)`);

  // ── Step 2: Create empty Yes/No ATAs for bid wallets ──
  // place_order requires user_yes_ata and user_no_ata to be valid token accounts.
  // Bid wallets don't mint, so we must create their ATAs with 0 balance.
  let atasCreated = 0;
  const bidBatches = batch(bidWallets, concurrency);

  for (const wb of bidBatches) {
    const promises = wb.map(async (wallet) => {
      for (const m of tradingMarkets) {
        try {
          // Create Yes ATA (empty)
          await getOrCreateAssociatedTokenAccount(
            connection, wallet, m.yesMint, wallet.publicKey,
          );
          // Create No ATA (empty)
          await getOrCreateAssociatedTokenAccount(
            connection, wallet, m.noMint, wallet.publicKey,
          );
          atasCreated++;
        } catch (e: any) {
          // Non-fatal: if ATA creation fails, the order will fail later
          stats.errors.push(`ata ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
        }
      }
    });
    await Promise.all(promises);
  }
  console.log(`  Bid wallet ATAs: ${atasCreated}/${ataTotal} created`);

  // ── Step 3: Mint pairs on lifecycle markets for 5 ask wallets ──
  // These tokens enable Phase 5 post-settlement redemption (modes 1/2)
  // and Phase 6 treasury_redeem testing.
  const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);
  const lifecycleWallets = askWallets.slice(0, 5);
  const lcMintTotal = lifecycleWallets.length * lifecycleMarkets.length;
  console.log(`  Minting pairs for ${lifecycleWallets.length} wallets × ${lifecycleMarkets.length} lifecycle markets (${lcMintTotal} mints)...`);

  let lcMinted = 0;
  for (const wallet of lifecycleWallets) {
    for (const m of lifecycleMarkets) {
      stats.attempted++;
      try {
        const ix = buildMintPairIx({
          user: wallet.publicKey,
          config: configPda,
          market: m.market,
          yesMint: m.yesMint,
          noMint: m.noMint,
          userUsdcAta: getAssociatedTokenAddressSync(usdcMint, wallet.publicKey),
          userYesAta: getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey),
          userNoAta: getAssociatedTokenAddressSync(m.noMint, wallet.publicKey),
          usdcVault: m.usdcVault,
          quantity,
        });
        await sendTx(connection, new Transaction().add(ix), [wallet]);
        stats.succeeded++;
        lcMinted++;
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`mint_lc ${m.def.ticker}: ${e.message?.slice(0, 100)}`);
      }
    }
  }
  console.log(`  Lifecycle mints: ${lcMinted}/${lcMintTotal}`);

  return { stats: finishPhaseStats(stats) };
}
