// ---------------------------------------------------------------------------
// Auto-Redemption — cranks redeem for settled markets past override deadline
//
// For each settled market where clock >= override_deadline:
//   1. Determine winning mint from outcome (1 = Yes, 2 = No)
//   2. Find all token holders of the winning mint via getProgramAccounts
//   3. Filter to non-zero balances
//   4. Batch into groups of 16 users (32 remaining_accounts)
//   5. Build and send crank_redeem instruction per batch
// ---------------------------------------------------------------------------

import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";

import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig } from "../../shared/src/pda.js";
import { MarketInfo, tickerFromBytes } from "./settler.js";

const log = createLogger("settlement:redeemer");

/** Max users per crank_redeem call (each user = 2 remaining_accounts) */
const MAX_USERS_PER_BATCH = 16;

interface RedeemResult {
  market: string;
  redeemed: number;
  batches: number;
  error?: string;
}

/**
 * Find all token accounts for a given mint with non-zero balance.
 * Returns the owner pubkeys.
 */
async function findWinningTokenHolders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  winningMint: PublicKey,
): Promise<{ owner: PublicKey; balance: bigint }[]> {
  const connection = program.provider.connection;

  // Query all token accounts for the winning mint
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0, // Mint is at offset 0 in SPL token account layout
          bytes: winningMint.toBase58(),
        },
      },
    ],
    dataSlice: {
      offset: 32, // Owner starts at offset 32
      length: 40, // Owner (32 bytes) + Amount (8 bytes)
    },
  });

  const holders: { owner: PublicKey; balance: bigint }[] = [];

  for (const { account } of accounts) {
    const owner = new PublicKey(account.data.subarray(0, 32));
    const balance = account.data.readBigUInt64LE(32);

    if (balance > 0n) {
      holders.push({ owner, balance });
    }
  }

  return holders;
}

/**
 * Redeem winning tokens for a single settled market.
 * Batches users into groups of 16 and sends crank_redeem per batch.
 */
async function redeemMarket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  market: MarketInfo,
  usdcMint: PublicKey,
): Promise<RedeemResult> {
  const ticker = tickerFromBytes(market.account.ticker);
  const [configPda] = findGlobalConfig();

  // Fetch the full market account to get outcome and override_deadline
  const marketAccount = await program.account.strikeMarket.fetch(market.publicKey);
  const outcome = marketAccount.outcome as number;
  const overrideDeadline = (marketAccount.overrideDeadline as BN).toNumber();

  // Guard: must be settled with a valid outcome
  if (!marketAccount.isSettled || (outcome !== 1 && outcome !== 2)) {
    return { market: ticker, redeemed: 0, batches: 0 };
  }

  // Guard: override window must have passed
  const now = Math.floor(Date.now() / 1000);
  if (now < overrideDeadline) {
    log.info(`Market ${ticker}: override window not yet passed (deadline ${overrideDeadline}, now ${now})`);
    return { market: ticker, redeemed: 0, batches: 0 };
  }

  // Determine winning mint
  const winningMint = outcome === 1 ? market.account.yesMint : market.account.noMint;

  // Find all holders of the winning token with non-zero balance
  const holders = await findWinningTokenHolders(program, winningMint);

  if (holders.length === 0) {
    log.info(`Market ${ticker}: no winning token holders to redeem`);
    return { market: ticker, redeemed: 0, batches: 0 };
  }

  log.info(`Market ${ticker}: found ${holders.length} winning token holders to redeem`, {
    market: market.publicKey.toBase58(),
    winningMint: winningMint.toBase58(),
    outcome,
  });

  let totalRedeemed = 0;
  let batchCount = 0;

  // Batch into groups of MAX_USERS_PER_BATCH
  for (let i = 0; i < holders.length; i += MAX_USERS_PER_BATCH) {
    const batch = holders.slice(i, i + MAX_USERS_PER_BATCH);
    batchCount++;

    // Build remaining_accounts: pairs of (user_winning_ata, user_usdc_ata)
    const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

    for (const holder of batch) {
      const userWinningAta = getAssociatedTokenAddressSync(winningMint, holder.owner, true);
      const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, holder.owner, true);

      remainingAccounts.push(
        { pubkey: userWinningAta, isSigner: false, isWritable: true },
        { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      );
    }

    const batchSize = remainingAccounts.length; // 2 accounts per user

    try {
      log.info(
        `Market ${ticker}: redeeming batch ${batchCount} (${batch.length} users, ${batchSize} remaining_accounts)`,
        { market: market.publicKey.toBase58() },
      );

      await program.methods
        .crankRedeem(batchSize)
        .accounts({
          caller: program.provider.publicKey!,
          config: configPda,
          market: market.publicKey,
          yesMint: market.account.yesMint,
          noMint: market.account.noMint,
          usdcVault: market.account.usdcVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

      totalRedeemed += batch.length;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(
        `Market ${ticker}: crank_redeem batch ${batchCount} failed: ${errMsg}`,
        {
          market: market.publicKey.toBase58(),
          batchUsers: batch.length,
        },
      );
      // Continue on individual batch failures — don't abort the whole market
    }
  }

  log.info(`Market ${ticker}: redemption complete — ${totalRedeemed}/${holders.length} users redeemed in ${batchCount} batches`);

  return { market: ticker, redeemed: totalRedeemed, batches: batchCount };
}

/**
 * Auto-redeem winning tokens for all settled markets past override deadline.
 * This is Step 4.5 in the settlement pipeline (after crank_cancel, before close_market).
 */
export async function autoRedeemAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  markets: MarketInfo[],
  usdcMint: PublicKey,
): Promise<RedeemResult[]> {
  const results: RedeemResult[] = [];

  for (const market of markets) {
    const ticker = tickerFromBytes(market.account.ticker);
    try {
      const result = await redeemMarket(program, market, usdcMint);
      results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Auto-redeem failed for ${ticker}: ${errMsg}`, {
        market: market.publicKey.toBase58(),
      });
      results.push({ market: ticker, redeemed: 0, batches: 0, error: errMsg });
    }
  }

  return results;
}
