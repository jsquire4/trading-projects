/**
 * phase3-mint-pairs.ts — Mint Yes/No token pairs across all trading markets.
 * Lifecycle markets (close in past) reject mints, so only trading markets are used.
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
import { findGlobalConfig, sendTx, type MarketAddresses } from "./helpers";
import { buildMintPairIx } from "./instructions";

/**
 * Phase 3: Each wallet mints token pairs on every trading market.
 * Wallets execute their mint sequence concurrently.
 */
export async function phase3MintPairs(
  connection: Connection,
  wallets: Keypair[],
  usdcMint: PublicKey,
  markets: MarketAddresses[],
): Promise<{ stats: PhaseStats }> {
  // Filter to trading markets only (lifecycle markets reject mints after close)
  const tradingMarkets = markets.filter((m) => !m.def.isLifecycle);
  const total = wallets.length * tradingMarkets.length;
  console.log(`\n[Phase 3] Minting ${DEFAULTS.PAIRS_PER_MARKET / 1_000_000} pairs per wallet × ${tradingMarkets.length} trading markets (${total} txns)...`);
  const stats = newPhaseStats("Mint Pairs");

  const [configPda] = findGlobalConfig();
  const quantity = new BN(DEFAULTS.PAIRS_PER_MARKET);
  let completed = 0;

  // Process wallets concurrently, each wallet's mints are sequential
  const concurrency = 20;
  const walletBatches: Keypair[][] = [];
  for (let i = 0; i < wallets.length; i += concurrency) {
    walletBatches.push(wallets.slice(i, i + concurrency));
  }

  for (const wb of walletBatches) {
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
          console.log(`  Progress: ${completed}/${total} mints`);
        }
      }
    });
    await Promise.all(promises);
  }

  console.log(`  Minted: ${stats.succeeded}/${stats.attempted} (${stats.failed} failed)`);
  return { stats: finishPhaseStats(stats) };
}
