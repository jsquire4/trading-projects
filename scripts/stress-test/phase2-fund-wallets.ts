/**
 * phase2-fund-wallets.ts — Generate 100 wallets, airdrop SOL, mint USDC.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  DEFAULTS,
  type PhaseStats,
  newPhaseStats,
  finishPhaseStats,
} from "./config";
import { fundWallet, batch } from "./helpers";

/**
 * Phase 2: Generate fresh wallets, airdrop SOL, and mint USDC.
 * Returns the array of funded Keypairs.
 */
export async function phase2FundWallets(
  connection: Connection,
  admin: Keypair,
  faucetKp: Keypair,
  usdcMint: PublicKey,
  existingWallets?: Keypair[],
): Promise<{ stats: PhaseStats; wallets: Keypair[] }> {
  const numWallets = DEFAULTS.NUM_WALLETS;
  console.log(`\n[Phase 2] Funding ${numWallets} wallets with ${DEFAULTS.SOL_PER_WALLET} SOL + $${DEFAULTS.USDC_PER_WALLET / 1_000_000} USDC each...`);
  const stats = newPhaseStats("Fund Wallets");

  // Generate or reuse wallets
  const wallets = existingWallets ?? Array.from({ length: numWallets }, () => Keypair.generate());

  // Fund in parallel batches of 10 to avoid overwhelming the RPC
  const walletBatches = batch(wallets, 10);
  let funded = 0;

  for (const wb of walletBatches) {
    const promises = wb.map(async (wallet) => {
      stats.attempted++;
      try {
        await fundWallet(
          connection,
          admin,
          faucetKp,
          usdcMint,
          wallet,
          DEFAULTS.SOL_PER_WALLET,
          DEFAULTS.USDC_PER_WALLET,
        );
        stats.succeeded++;
        funded++;
        if (funded % 20 === 0) {
          console.log(`  Progress: ${funded}/${numWallets} wallets funded`);
        }
      } catch (e: any) {
        stats.failed++;
        stats.errors.push(`fund wallet ${wallet.publicKey.toBase58().slice(0, 8)}: ${e.message?.slice(0, 120)}`);
      }
    });
    await Promise.all(promises);
  }

  // Verify a sample
  const sampleSize = Math.min(5, wallets.length);
  let verified = 0;
  for (let i = 0; i < sampleSize; i++) {
    const w = wallets[i];
    const bal = await connection.getBalance(w.publicKey);
    if (bal > 0) {
      try {
        const ata = getAssociatedTokenAddressSync(usdcMint, w.publicKey);
        const acct = await getAccount(connection, ata);
        if (acct.amount > 0n) verified++;
      } catch { /* skip */ }
    }
  }
  console.log(`  Funded: ${funded}/${numWallets}. Sample verification: ${verified}/${sampleSize} have SOL+USDC`);

  return { stats: finishPhaseStats(stats), wallets };
}
