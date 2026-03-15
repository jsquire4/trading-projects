/**
 * remediation.test.ts — Tests for on-chain remediation changes:
 *
 * 1. Permissionless strike creation (non-admin can create markets)
 * 2. Strike creation fee (non-admin pays fee, admin is exempt)
 * 3. update_strike_creation_fee instruction (admin-only setter)
 * 4. crank_redeem instruction (permissionless batch redemption)
 */

import { expect } from "chai";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import BN from "bn.js";

import {
  setupBankrun,
  BankrunContext,
  createMockUsdc,
  initializeConfig,
  initializeOracleFeed,
  updateOraclePrice,
  createTestMarket,
  mintTestUsdc,
  createAta,
  MarketAccounts,
  findGlobalConfig,
  findFeeVault,
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  MOCK_ORACLE_PROGRAM_ID,
  MERIDIAN_PROGRAM_ID,
} from "../helpers";

import {
  buildUpdateStrikeCreationFeeIx,
  buildCreateStrikeMarketIx,
  buildCrankRedeemIx,
  buildMintPairIx,
  buildSettleMarketIx,
  buildAdminSettleIx,
  buildUpdatePriceIx,
  padTicker,
} from "../helpers/instructions";

import {
  getTokenBalance,
  advanceClock,
  readMarket,
} from "../helpers/market-layout";
import { createFundedUser, createFundedUserWithMarketAtas } from "../helpers/mint-helpers";
import { makeUniqueCuIxFactory } from "../helpers/tx-helpers";

const uniqueCuIx = makeUniqueCuIxFactory(400_000);
const ONE_TOKEN = 1_000_000;

// ===========================================================================
// update_strike_creation_fee
// ===========================================================================
describe("Update Strike Creation Fee", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;

  before(async () => {
    ctx = await setupBankrun();
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
  });

  // strike_creation_fee offset: 8 (disc) + 32+32+32 (pubkeys) + 8+8+8 (u64s)
  // + 1 (is_paused) + 1 (oracle_type) + 56 (tickers) + 1 (ticker_count) + 1 (bump)
  // + 2 (fee_bps) + 2 (_padding) = 192
  const STRIKE_FEE_OFFSET = 192;

  async function readStrikeCreationFee(): Promise<bigint> {
    const acct = await ctx.context.banksClient.getAccount(config);
    return Buffer.from(acct!.data).readBigUInt64LE(STRIKE_FEE_OFFSET);
  }

  it("strike_creation_fee defaults to 0", async () => {
    const fee = await readStrikeCreationFee();
    expect(Number(fee)).to.equal(0);
  });

  it("admin can set strike_creation_fee", async () => {
    const provider = new BankrunProvider(ctx.context);
    const ix = buildUpdateStrikeCreationFeeIx(
      { admin: ctx.admin.publicKey, config },
      new BN(5_000_000), // $5 fee
    );
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

    const fee = await readStrikeCreationFee();
    expect(Number(fee)).to.equal(5_000_000);
  });

  it("admin can set strike_creation_fee to 0", async () => {
    const provider = new BankrunProvider(ctx.context);
    const ix = buildUpdateStrikeCreationFeeIx(
      { admin: ctx.admin.publicKey, config },
      new BN(0),
    );
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

    const fee = await readStrikeCreationFee();
    expect(Number(fee)).to.equal(0);
  });

  it("non-admin is rejected (Unauthorized)", async () => {
    const nonAdmin = Keypair.generate();
    ctx.context.setAccount(nonAdmin.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    const provider = new BankrunProvider(ctx.context);
    const ix = buildUpdateStrikeCreationFeeIx(
      { admin: nonAdmin.publicKey, config },
      new BN(1_000_000),
    );

    try {
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [nonAdmin]);
      expect.fail("Should have rejected non-admin");
    } catch (e: any) {
      // Unauthorized = 0, on-chain code 6000 = 0x1770
      expect(String(e)).to.match(/0x1770|Unauthorized|6000|custom program error/i);
    }
  });
});

// ===========================================================================
// Permissionless Strike Creation + Fee
// ===========================================================================
describe("Permissionless Strike Creation", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;

  const TICKER = "AAPL";

  before(async () => {
    ctx = await setupBankrun();
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 198_000_000, 500_000);
  });

  /**
   * Helper: create a market from a non-admin user (permissionless).
   * Pre-allocates the OrderBook PDA (same as createTestMarket) but uses the
   * user as the creator signer instead of admin.
   */
  async function createMarketAsUser(
    user: Keypair,
    strikePrice: number,
    marketCloseUnix: number,
    creatorUsdcAta?: PublicKey,
  ): Promise<MarketAccounts> {
    const provider = new BankrunProvider(ctx.context);
    const strikePriceBN = new BN(strikePrice);
    const expiryDay = Math.floor(marketCloseUnix / 86400);

    const [market] = findStrikeMarket(TICKER, strikePriceBN, marketCloseUnix);
    const [yesMint] = findYesMint(market);
    const [noMint] = findNoMint(market);
    const [usdcVault] = findUsdcVault(market);
    const [escrowVault] = findEscrowVault(market);
    const [yesEscrow] = findYesEscrow(market);
    const [noEscrow] = findNoEscrow(market);
    const [orderBook] = findOrderBook(market);

    const ix = buildCreateStrikeMarketIx({
      admin: user.publicKey, // creator field — the key array uses `admin` name for backward compat
      config,
      market,
      yesMint,
      noMint,
      usdcVault,
      escrowVault,
      yesEscrow,
      noEscrow,
      orderBook,
      oracleFeed,
      usdcMint,
      creatorUsdcAta: creatorUsdcAta,
      feeVault: creatorUsdcAta ? feeVault : undefined,
      ticker: padTicker(TICKER),
      strikePrice: strikePriceBN,
      expiryDay,
      marketCloseUnix: new BN(marketCloseUnix),
      previousClose: new BN(195_000_000),
    });

    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm!(tx, [user]);

    return {
      market,
      yesMint,
      noMint,
      usdcVault,
      escrowVault,
      yesEscrow,
      noEscrow,
      orderBook,
    };
  }

  it("non-admin can create a market when fee is 0", async () => {
    // Ensure fee is 0
    const provider = new BankrunProvider(ctx.context);
    const setFeeIx = buildUpdateStrikeCreationFeeIx(
      { admin: ctx.admin.publicKey, config },
      new BN(0),
    );
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), setFeeIx), [ctx.admin]);

    // Create non-admin user with SOL
    const user = Keypair.generate();
    ctx.context.setAccount(user.publicKey, {
      lamports: 50_000_000_000, // 50 SOL for rent
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    const clock = await ctx.context.banksClient.getClock();
    const marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    const ma = await createMarketAsUser(user, 200_000_000, marketCloseUnix);

    // Verify market was created with correct fields
    const acct = await ctx.context.banksClient.getAccount(ma.market);
    expect(acct).to.not.be.null;
    expect(acct!.owner.toBase58()).to.equal(MERIDIAN_PROGRAM_ID.toBase58());
    const m = await readMarket(ctx, ma.market);
    expect(Number(m.strikePrice)).to.equal(200_000_000);
    expect(m.isSettled).to.be.false;
    expect(m.outcome).to.equal(0);
  });

  it("admin creates market without paying fee even when fee > 0", async () => {
    const provider = new BankrunProvider(ctx.context);

    // Set a fee
    const setFeeIx = buildUpdateStrikeCreationFeeIx(
      { admin: ctx.admin.publicKey, config },
      new BN(5_000_000), // $5
    );
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), setFeeIx), [ctx.admin]);

    const clock = await ctx.context.banksClient.getClock();
    const marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    // Record fee_vault balance before
    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    // Admin creates market — should succeed without needing USDC ATA
    const ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      210_000_000, marketCloseUnix, 195_000_000,
      oracleFeed, usdcMint,
    );

    const acct = await ctx.context.banksClient.getAccount(ma.market);
    expect(acct).to.not.be.null;

    // Verify no fee was charged (fee_vault balance unchanged)
    const feeVaultAfter = await getTokenBalance(ctx, feeVault);
    expect(feeVaultAfter).to.equal(feeVaultBefore);
  });

  it("non-admin pays strike_creation_fee when fee > 0", async () => {
    const provider = new BankrunProvider(ctx.context);

    // Ensure fee is set to $5
    const setFeeIx = buildUpdateStrikeCreationFeeIx(
      { admin: ctx.admin.publicKey, config },
      new BN(5_000_000),
    );
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), setFeeIx), [ctx.admin]);

    // Create non-admin user with SOL and USDC
    const user = Keypair.generate();
    ctx.context.setAccount(user.publicKey, {
      lamports: 50_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    const userUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, user.publicKey);
    await mintTestUsdc(ctx.context, usdcMint, ctx.admin, userUsdcAta, 100_000_000);

    const usdcBefore = await getTokenBalance(ctx, userUsdcAta);
    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    const clock = await ctx.context.banksClient.getClock();
    const marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    await createMarketAsUser(user, 220_000_000, marketCloseUnix, userUsdcAta);

    // Verify fee was deducted from user
    const usdcAfter = await getTokenBalance(ctx, userUsdcAta);
    expect(usdcBefore - usdcAfter).to.equal(5_000_000);

    // Verify fee_vault received the fee
    const feeVaultAfter = await getTokenBalance(ctx, feeVault);
    expect(feeVaultAfter - feeVaultBefore).to.equal(5_000_000);
  });

  it("non-admin without USDC fails when fee > 0", async () => {
    const provider = new BankrunProvider(ctx.context);

    // Ensure fee is set
    const strikeFeeOffset = 192;
    const acct = await ctx.context.banksClient.getAccount(config);
    const currentFee = Buffer.from(acct!.data).readBigUInt64LE(strikeFeeOffset);
    expect(Number(currentFee)).to.equal(5_000_000);

    // Create non-admin user with SOL but no USDC
    const user = Keypair.generate();
    ctx.context.setAccount(user.publicKey, {
      lamports: 50_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    // Create USDC ATA with 0 balance
    const userUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, user.publicKey);

    const clock = await ctx.context.banksClient.getClock();
    const marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    try {
      await createMarketAsUser(user, 230_000_000, marketCloseUnix, userUsdcAta);
      expect.fail("Should have failed due to insufficient USDC for fee");
    } catch (e: any) {
      // SPL token transfer insufficient funds or InsufficientBalance
      expect(String(e)).to.match(/insufficient|InsufficientBalance|custom program error/i);
    }
  });
});

// ===========================================================================
// crank_redeem
// ===========================================================================
describe("Crank Redeem", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;
  let marketCloseUnix: number;

  const TICKER = "NVDA";
  const STRIKE_PRICE = 500_000_000;
  const PREVIOUS_CLOSE = 490_000_000;

  // Users who hold winning tokens
  let user1: Keypair;
  let user1UsdcAta: PublicKey;
  let user1YesAta: PublicKey;
  let user1NoAta: PublicKey;

  let user2: Keypair;
  let user2UsdcAta: PublicKey;
  let user2YesAta: PublicKey;
  let user2NoAta: PublicKey;

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 5;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 510_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // Create two users and mint pairs
    const u1 = await createFundedUserWithMarketAtas(
      ctx.context, ctx.admin, usdcMint, ma, 100_000_000,
    );
    user1 = u1.user;
    user1UsdcAta = u1.userUsdcAta;
    user1YesAta = u1.userYesAta;
    user1NoAta = u1.userNoAta;

    const u2 = await createFundedUserWithMarketAtas(
      ctx.context, ctx.admin, usdcMint, ma, 100_000_000,
    );
    user2 = u2.user;
    user2UsdcAta = u2.userUsdcAta;
    user2YesAta = u2.userYesAta;
    user2NoAta = u2.userNoAta;

    // Mint pairs for both users
    const provider = new BankrunProvider(ctx.context);
    for (const [user, uAta, yAta, nAta] of [
      [user1, user1UsdcAta, user1YesAta, user1NoAta],
      [user2, user2UsdcAta, user2YesAta, user2NoAta],
    ] as [Keypair, PublicKey, PublicKey, PublicKey][]) {
      const mintIx = buildMintPairIx({
        user: user.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: uAta,
        userYesAta: yAta,
        userNoAta: nAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(50 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(mintIx), [user]);
    }

    // Settle the market: Yes wins (oracle > strike)
    await advanceClock(ctx, marketCloseUnix + 10);

    const updateIx = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed: oracleFeed,
      price: new BN(510_000_000),
      confidence: new BN(500_000),
      timestamp: new BN(marketCloseUnix + 10),
    });
    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), updateIx),
      [ctx.admin],
    );

    const settleIx = buildSettleMarketIx({
      caller: ctx.admin.publicKey,
      config,
      market: ma.market,
      oracleFeed,
    });
    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), settleIx),
      [ctx.admin],
    );

    // Verify settlement
    const m = await readMarket(ctx, ma.market);
    expect(m.isSettled).to.be.true;
    expect(m.outcome).to.equal(1); // Yes wins
  });

  it("rejects crank_redeem during override window", async () => {
    const provider = new BankrunProvider(ctx.context);

    // Still within override window (settled_at + 3600)
    const m = await readMarket(ctx, ma.market);
    const withinWindow = m.settledAt + 100;
    await advanceClock(ctx, withinWindow);

    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1YesAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    try {
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );
      expect.fail("Expected CrankRedeemOverrideActive error");
    } catch (e: any) {
      // CrankRedeemOverrideActive = 140, on-chain 6140 = 0x17fc
      expect(String(e)).to.match(/0x17fc|CrankRedeemOverrideActive|6140|custom program error/i);
    }
  });

  it("rejects crank_redeem with no remaining accounts", async () => {
    const provider = new BankrunProvider(ctx.context);

    // Advance past override window
    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 10);

    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [], // no remaining accounts
    );

    try {
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );
      expect.fail("Expected InsufficientAccounts error");
    } catch (e: any) {
      // InsufficientAccounts = 37, on-chain 6037 = 0x1795
      expect(String(e)).to.match(/0x1795|InsufficientAccounts|6037|custom program error/i);
    }
  });

  it("crank_redeem successfully burns winning tokens and transfers USDC", async () => {
    // mint_pair pre-approves the market PDA as delegate on both Yes and No ATAs,
    // so crank_redeem can burn winning tokens and transfer USDC without user interaction.
    const provider = new BankrunProvider(ctx.context);

    // Advance past override deadline
    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 100);

    // Record balances before crank
    const yesBefore = await getTokenBalance(ctx, user1YesAta);
    const usdcBefore = await getTokenBalance(ctx, user1UsdcAta);
    expect(yesBefore).to.equal(50 * ONE_TOKEN); // user1 holds 50 Yes tokens

    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1YesAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), ix),
      [ctx.admin],
    );

    // Verify: Yes tokens burned to 0
    const yesAfter = await getTokenBalance(ctx, user1YesAta);
    expect(yesAfter).to.equal(0);

    // Verify: USDC credited ($1 per winning token = 50 * ONE_TOKEN)
    const usdcAfter = await getTokenBalance(ctx, user1UsdcAta);
    expect(usdcAfter).to.equal(usdcBefore + 50 * ONE_TOKEN);

    // Verify: market.total_redeemed updated
    const mAfter = await readMarket(ctx, ma.market);
    expect(Number(mAfter.totalRedeemed)).to.equal(50 * ONE_TOKEN);
  });

  it("multi-user batch: cranks both users in one tx", async () => {
    // user1 was already redeemed in previous test; user2 still has 50 Yes tokens
    const provider = new BankrunProvider(ctx.context);
    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 200);

    const user2YesBefore = await getTokenBalance(ctx, user2YesAta);
    expect(user2YesBefore).to.equal(50 * ONE_TOKEN);
    const user2UsdcBefore = await getTokenBalance(ctx, user2UsdcAta);

    // Pass both users — user1 has 0 balance (already redeemed), user2 has 50 tokens
    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1YesAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
        { pubkey: user2YesAta, isSigner: false, isWritable: true },
        { pubkey: user2UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), ix),
      [ctx.admin],
    );

    // user1 was already 0 — should be skipped, no error
    const user1YesAfter = await getTokenBalance(ctx, user1YesAta);
    expect(user1YesAfter).to.equal(0);

    // user2 should be redeemed
    const user2YesAfter = await getTokenBalance(ctx, user2YesAta);
    expect(user2YesAfter).to.equal(0);
    const user2UsdcAfter = await getTokenBalance(ctx, user2UsdcAta);
    expect(user2UsdcAfter).to.equal(user2UsdcBefore + 50 * ONE_TOKEN);

    // total_redeemed should now be 100 tokens (50 from previous test + 50 from this one)
    const mAfter = await readMarket(ctx, ma.market);
    expect(Number(mAfter.totalRedeemed)).to.equal(100 * ONE_TOKEN);
  });

  it("double-crank of already-redeemed users returns CrankRedeemEmpty", async () => {
    // Both users already redeemed — all balances are 0
    const provider = new BankrunProvider(ctx.context);
    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 300);

    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1YesAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    try {
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );
      expect.fail("Expected CrankRedeemEmpty error");
    } catch (e: any) {
      // CrankRedeemEmpty = 141, on-chain 6141 = 0x17fd
      expect(String(e)).to.match(/0x17fd|CrankRedeemEmpty|6141|custom program error/i);
    }
  });
});

// ===========================================================================
// crank_redeem — No Wins scenario
// ===========================================================================
describe("Crank Redeem (No Wins)", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;
  let marketCloseUnix: number;

  const TICKER = "GOOGL";
  const STRIKE_PRICE = 500_000_000;
  const PREVIOUS_CLOSE = 490_000_000;

  let user1: Keypair;
  let user1UsdcAta: PublicKey;
  let user1YesAta: PublicKey;
  let user1NoAta: PublicKey;

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 5;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    // Oracle price BELOW strike → No wins
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 480_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    const u1 = await createFundedUserWithMarketAtas(
      ctx.context, ctx.admin, usdcMint, ma, 100_000_000,
    );
    user1 = u1.user;
    user1UsdcAta = u1.userUsdcAta;
    user1YesAta = u1.userYesAta;
    user1NoAta = u1.userNoAta;

    // Mint pairs
    const provider = new BankrunProvider(ctx.context);
    const mintIx = buildMintPairIx({
      user: user1.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: user1UsdcAta,
      userYesAta: user1YesAta,
      userNoAta: user1NoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(30 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(mintIx), [user1]);

    // Settle: No wins (oracle < strike)
    await advanceClock(ctx, marketCloseUnix + 10);

    const updateIx = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed: oracleFeed,
      price: new BN(480_000_000),
      confidence: new BN(500_000),
      timestamp: new BN(marketCloseUnix + 10),
    });
    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), updateIx),
      [ctx.admin],
    );

    const settleIx = buildSettleMarketIx({
      caller: ctx.admin.publicKey,
      config,
      market: ma.market,
      oracleFeed,
    });
    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), settleIx),
      [ctx.admin],
    );

    const m = await readMarket(ctx, ma.market);
    expect(m.isSettled).to.be.true;
    expect(m.outcome).to.equal(2); // No wins
  });

  it("crank_redeem redeems No winners (outcome=2)", async () => {
    const provider = new BankrunProvider(ctx.context);

    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 100);

    const noBefore = await getTokenBalance(ctx, user1NoAta);
    expect(noBefore).to.equal(30 * ONE_TOKEN);
    const usdcBefore = await getTokenBalance(ctx, user1UsdcAta);

    // Pass No ATA (winning side) + USDC ATA
    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1NoAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    await provider.sendAndConfirm!(
      new Transaction().add(uniqueCuIx(), ix),
      [ctx.admin],
    );

    // No tokens burned
    const noAfter = await getTokenBalance(ctx, user1NoAta);
    expect(noAfter).to.equal(0);

    // USDC credited
    const usdcAfter = await getTokenBalance(ctx, user1UsdcAta);
    expect(usdcAfter).to.equal(usdcBefore + 30 * ONE_TOKEN);

    // total_redeemed updated
    const mAfter = await readMarket(ctx, ma.market);
    expect(Number(mAfter.totalRedeemed)).to.equal(30 * ONE_TOKEN);
  });

  it("skips user with wrong mint (Yes ATA when No wins) gracefully", async () => {
    const provider = new BankrunProvider(ctx.context);

    const m = await readMarket(ctx, ma.market);
    await advanceClock(ctx, m.overrideDeadline + 200);

    // Pass Yes ATA instead of No ATA — should be skipped (wrong mint)
    const ix = buildCrankRedeemIx(
      {
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
      },
      32,
      [
        { pubkey: user1YesAta, isSigner: false, isWritable: true },
        { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
      ],
    );

    try {
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );
      expect.fail("Expected CrankRedeemEmpty (wrong mint skipped, no redemptions)");
    } catch (e: any) {
      // All users skipped → CrankRedeemEmpty = 141, on-chain 6141 = 0x17fd
      expect(String(e)).to.match(/0x17fd|CrankRedeemEmpty|6141|custom program error/i);
    }
  });
});
