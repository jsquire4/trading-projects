/**
 * mint-helpers.ts — Shared helpers for creating funded users and executing
 * mint_pair transactions in bankrun tests.
 */

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BankrunProvider } from "anchor-bankrun";
import BN from "bn.js";
import { ProgramTestContext } from "solana-bankrun";

import { buildMintPairIx } from "./instructions";
import { createAta, mintTestUsdc, MarketAccounts, findYesMint, findNoMint } from "./setup";

// ---------------------------------------------------------------------------
// createFundedUser
// ---------------------------------------------------------------------------

/**
 * Create a fresh keypair funded with SOL and optionally USDC.
 *
 * @param context    Bankrun ProgramTestContext
 * @param admin      Admin keypair (payer for ATA creation and mint authority)
 * @param usdcMint   USDC mint address
 * @param usdcAmount Amount of USDC lamports to mint (0 = no USDC)
 */
export async function createFundedUser(
  context: ProgramTestContext,
  admin: Keypair,
  usdcMint: PublicKey,
  usdcAmount: number,
): Promise<{ user: Keypair; userUsdcAta: PublicKey }> {
  const user = Keypair.generate();

  // Fund the user with SOL via context
  context.setAccount(user.publicKey, {
    lamports: 10_000_000_000, // 10 SOL
    data: Buffer.alloc(0),
    owner: PublicKey.default,
    executable: false,
  });

  // Create USDC ATA for user
  const userUsdcAta = await createAta(context, admin, usdcMint, user.publicKey);

  if (usdcAmount > 0) {
    await mintTestUsdc(context, usdcMint, admin, userUsdcAta, usdcAmount);
  }

  return { user, userUsdcAta };
}

// ---------------------------------------------------------------------------
// createFundedUserWithMarketAtas
// ---------------------------------------------------------------------------

/**
 * Create a fresh keypair funded with SOL and USDC, plus Yes/No ATAs for a market.
 *
 * Consolidates the 6-step inline pattern used across place-order and settlement tests:
 *   1. Generate keypair
 *   2. Fund with SOL
 *   3. Create USDC ATA + mint USDC
 *   4. Create Yes ATA
 *   5. Create No ATA
 */
export async function createFundedUserWithMarketAtas(
  context: ProgramTestContext,
  admin: Keypair,
  usdcMint: PublicKey,
  marketAccounts: MarketAccounts,
  usdcAmount: number,
): Promise<{ user: Keypair; userUsdcAta: PublicKey; userYesAta: PublicKey; userNoAta: PublicKey }> {
  const { user, userUsdcAta } = await createFundedUser(context, admin, usdcMint, usdcAmount);
  const userYesAta = await createAta(context, admin, marketAccounts.yesMint, user.publicKey);
  const userNoAta = await createAta(context, admin, marketAccounts.noMint, user.publicKey);
  return { user, userUsdcAta, userYesAta, userNoAta };
}

// ---------------------------------------------------------------------------
// executeMintPair
// ---------------------------------------------------------------------------

/**
 * Build and send a mint_pair transaction.
 *
 * @param context        Bankrun ProgramTestContext
 * @param user           User keypair (signer)
 * @param userUsdcAta    User's USDC ATA
 * @param config         GlobalConfig PDA
 * @param marketAccounts Market accounts (market, yesMint, noMint, usdcVault)
 * @param quantity       Amount of token pairs to mint (in lamports)
 */
export async function executeMintPair(
  context: ProgramTestContext,
  user: Keypair,
  userUsdcAta: PublicKey,
  config: PublicKey,
  marketAccounts: MarketAccounts,
  quantity: number,
): Promise<void> {
  const provider = new BankrunProvider(context);
  const userYesAta = getAssociatedTokenAddressSync(
    marketAccounts.yesMint,
    user.publicKey,
  );
  const userNoAta = getAssociatedTokenAddressSync(
    marketAccounts.noMint,
    user.publicKey,
  );

  const ix = buildMintPairIx({
    user: user.publicKey,
    config,
    market: marketAccounts.market,
    yesMint: marketAccounts.yesMint,
    noMint: marketAccounts.noMint,
    userUsdcAta,
    userYesAta,
    userNoAta,
    usdcVault: marketAccounts.usdcVault,
    quantity: new BN(quantity),
  });

  // Add a unique CU nonce to prevent bankrun "already processed" dedup
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + Math.floor(Math.random() * 100_000) });
  const tx = new Transaction().add(cuIx).add(ix);
  await provider.sendAndConfirm!(tx, [user]);
}
