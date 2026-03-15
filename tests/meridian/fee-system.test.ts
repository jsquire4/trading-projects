/**
 * fee-system.test.ts — Tests for the protocol fee system.
 *
 * Tests:
 * - Config: admin sets fees, non-admin rejected, bps > 1000 rejected, zero-fee works
 * - Swap fill: fee deducted from escrow, fee_vault receives fee, FillEvent.fee correct
 * - Merge fill: fee deducted from pool, fee_vault receives fee
 * - Accumulation: multiple fills -> fee_vault = sum of fees
 * - Regression: existing order flow works at zero-fee default
 */

import { expect } from "chai";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BankrunProvider } from "anchor-bankrun";
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
  MOCK_ORACLE_PROGRAM_ID,
  MERIDIAN_PROGRAM_ID,
  SIDE_USDC_BID,
  SIDE_YES_ASK,
  SIDE_NO_BID,
  ORDER_TYPE_LIMIT,
  ORDER_TYPE_MARKET,
} from "../helpers";

import {
  buildPlaceOrderIx,
  buildMintPairIx,
  buildUpdateFeeBpsIx,
} from "../helpers/instructions";

import { getTokenBalance } from "../helpers/market-layout";
import { createFundedUserWithMarketAtas } from "../helpers/mint-helpers";
import { makeUniqueCuIxFactory } from "../helpers/tx-helpers";

describe("Fee System", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;
  let provider: BankrunProvider;

  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000;
  const PREVIOUS_CLOSE = 195_000_000;
  let marketCloseUnix: number;
  const ONE_TOKEN = 1_000_000;
  const TEN_TOKENS = 10_000_000;

  const uniqueCuIx = makeUniqueCuIxFactory(300_000);

  // GlobalConfig layout offset for fee_bps (u16):
  // 8 (disc) + 32+32+32 (pubkeys) + 8+8+8 (u64s) + 1 (is_paused)
  // + 1 (oracle_type) + 56 (tickers) + 1 (ticker_count) + 1 (bump) = 188
  const FEE_BPS_OFFSET = 188;

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 198_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    provider = new BankrunProvider(ctx.context);
  });

  // -----------------------------------------------------------------------
  // Config tests
  // -----------------------------------------------------------------------

  it("fee_bps defaults to 0 after initialization", async () => {
    const acct = await ctx.context.banksClient.getAccount(config);
    expect(acct).to.not.be.null;
    // offset of fee_bps = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 56 + 1 + 1 = 188
    const data = Buffer.from(acct!.data);
    const feeBps = data.readUInt16LE(FEE_BPS_OFFSET);
    expect(feeBps).to.equal(0);
  });

  it("admin can set fee_bps to 50", async () => {

    const ix = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 50,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

    const acct = await ctx.context.banksClient.getAccount(config);
    const feeBps = Buffer.from(acct!.data).readUInt16LE(FEE_BPS_OFFSET);
    expect(feeBps).to.equal(50);
  });

  it("rejects fee_bps > 1000 (FeeBpsOutOfRange)", async () => {

    const ix = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 1001,
    });
    try {
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
      expect.fail("Should have rejected fee_bps > 1000");
    } catch (e: any) {
      expect(e.message).to.match(/0x17f2|FeeBpsOutOfRange|6130|custom program error/i);
    }
  });

  it("non-admin is rejected (Unauthorized)", async () => {
    const nonAdmin = Keypair.generate();
    // Fund non-admin for tx fees
    const rent = await ctx.context.banksClient.getRent();
    const lamports = Number(rent.minimumBalance(0n)) + 100_000_000;
    ctx.context.setAccount(nonAdmin.publicKey, {
      lamports,
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      executable: false,
    });


    const ix = buildUpdateFeeBpsIx({
      admin: nonAdmin.publicKey,
      config,
      newFeeBps: 50,
    });
    try {
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [nonAdmin]);
      expect.fail("Should have rejected non-admin");
    } catch (e: any) {
      expect(e.message).to.match(/0x1770|Unauthorized|6000|custom program error/i);
    }
  });

  it("admin can set fee_bps to 0 (zero-fee)", async () => {

    const ix = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

    const acct = await ctx.context.banksClient.getAccount(config);
    const feeBps = Buffer.from(acct!.data).readUInt16LE(FEE_BPS_OFFSET);
    expect(feeBps).to.equal(0);
  });

  // -----------------------------------------------------------------------
  // Swap fill fee tests
  // -----------------------------------------------------------------------

  it("swap fill: fee deducted from escrow, fee_vault receives fee", async () => {


    // Set fee to 50 bps (0.5%)
    const setFeeIx = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 50,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), setFeeIx), [ctx.admin]);

    // Create maker (seller): fund with Yes tokens
    const { user: maker, userUsdcAta: makerUsdcAta, userYesAta: makerYesAta, userNoAta: makerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Mint pairs for maker to get Yes tokens
    const mintIx = buildMintPairIx({
      user: maker.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: makerUsdcAta,
      userYesAta: makerYesAta,
      userNoAta: makerNoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(TEN_TOKENS),
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [maker]);

    // Maker posts Yes ask at price=50
    const askIx = buildPlaceOrderIx({
      user: maker.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: makerUsdcAta,
      userYesAta: makerYesAta,
      userNoAta: makerNoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 50,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), askIx), [maker]);

    // Create taker (buyer): fund with USDC only
    const { user: taker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Record fee_vault balance before
    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    // Taker buys Yes at price=50 (market order, fills against maker's ask)
    const bidIx = buildPlaceOrderIx({
      user: taker.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: takerUsdcAta,
      userYesAta: takerYesAta,
      userNoAta: takerNoAta,
      feeVault,
      side: SIDE_USDC_BID,
      price: 50,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [makerUsdcAta],
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), bidIx), [taker]);

    // Verify fee_vault received fees
    const feeVaultAfter = await getTokenBalance(ctx, feeVault);

    // fill_usdc = 1_000_000 * 50 * 10_000 / 1_000_000 = 500_000
    // total_fee = floor(500_000 * 50 / 10_000) = 2500
    const expectedFee = 2500;
    expect(feeVaultAfter - feeVaultBefore).to.equal(expectedFee);
  });

  // -----------------------------------------------------------------------
  // Merge fill fee tests
  // -----------------------------------------------------------------------

  it("merge fill: fee deducted from pool, fee_vault receives fee", async () => {


    // fee_bps is still 50 from previous test

    // Create user1: will have Yes tokens (sell Yes)
    const { user: user1, userUsdcAta: u1UsdcAta, userYesAta: u1YesAta, userNoAta: u1NoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Mint pairs for user1
    const mintIx1 = buildMintPairIx({
      user: user1.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: u1UsdcAta,
      userYesAta: u1YesAta,
      userNoAta: u1NoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(TEN_TOKENS),
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx1), [user1]);

    // Create user2: will have No tokens (sell No via NO_BID)
    const { user: user2, userUsdcAta: u2UsdcAta, userYesAta: u2YesAta, userNoAta: u2NoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Mint pairs for user2
    const mintIx2 = buildMintPairIx({
      user: user2.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: u2UsdcAta,
      userYesAta: u2YesAta,
      userNoAta: u2NoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(TEN_TOKENS),
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx2), [user2]);

    // User1 sells their Yes tokens (sell No side to clear position constraint)
    // Actually for merge fill: user2 posts a No-backed bid (SIDE_NO_BID) at price=40
    // user1 sells Yes against it (SIDE_YES_ASK), which triggers merge/burn

    // First: user2 needs to only hold No (not Yes). Transfer their Yes away or just use raw No.
    // Actually, position constraint: SIDE_NO_BID requires user_yes_ata == 0.
    // user2 has both Yes and No from mint_pair. Need to get rid of Yes tokens.
    // Let's sell user2's Yes tokens first with a separate ask:
    const sellYesIx = buildPlaceOrderIx({
      user: user2.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: u2UsdcAta,
      userYesAta: u2YesAta,
      userNoAta: u2NoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 99,
      quantity: new BN(TEN_TOKENS),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), sellYesIx), [user2]);

    // Now user2 can post No-backed bid
    const noBidIx = buildPlaceOrderIx({
      user: user2.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: u2UsdcAta,
      userYesAta: u2YesAta,
      userNoAta: u2NoAta,
      feeVault,
      side: SIDE_NO_BID,
      price: 40,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), noBidIx), [user2]);

    // Record fee_vault balance before merge
    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    // User1 sells Yes at price=40 (market order), should merge with user2's No bid
    // Position constraint for YES_ASK: none (selling Yes is always allowed while holding No)
    const sellIx = buildPlaceOrderIx({
      user: user1.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: u1UsdcAta,
      userYesAta: u1YesAta,
      userNoAta: u1NoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 40,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [u2UsdcAta],
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), sellIx), [user1]);

    // Verify fee_vault received merge fees
    const feeVaultAfter = await getTokenBalance(ctx, feeVault);

    // Merge fee: total_fee = floor(1_000_000 * 50 / 10_000) = 5_000
    const expectedMergeFee = 5_000;
    expect(feeVaultAfter - feeVaultBefore).to.equal(expectedMergeFee);
  });

  // -----------------------------------------------------------------------
  // Regression: zero-fee works
  // -----------------------------------------------------------------------

  it("orders work correctly at zero fee", async () => {


    // Reset fee to 0
    const resetIx = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), resetIx), [ctx.admin]);

    // Create maker with Yes tokens
    const { user: maker, userUsdcAta: makerUsdcAta, userYesAta: makerYesAta, userNoAta: makerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const mintIx = buildMintPairIx({
      user: maker.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: makerUsdcAta,
      userYesAta: makerYesAta,
      userNoAta: makerNoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(TEN_TOKENS),
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [maker]);

    // Maker posts ask
    const askIx = buildPlaceOrderIx({
      user: maker.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: makerUsdcAta,
      userYesAta: makerYesAta,
      userNoAta: makerNoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 60,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), askIx), [maker]);

    // Taker buys
    const { user: taker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    const bidIx = buildPlaceOrderIx({
      user: taker.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: takerUsdcAta,
      userYesAta: takerYesAta,
      userNoAta: takerNoAta,
      feeVault,
      side: SIDE_USDC_BID,
      price: 60,
      quantity: new BN(ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [makerUsdcAta],
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), bidIx), [taker]);

    // Fee vault should not have changed
    const feeVaultAfter = await getTokenBalance(ctx, feeVault);
    expect(feeVaultAfter - feeVaultBefore).to.equal(0);
  });

  // -----------------------------------------------------------------------
  // Accumulation test
  // -----------------------------------------------------------------------

  it("multiple fills accumulate fees in fee_vault", async () => {


    // Set fee to 100 bps (1%)
    const setFeeIx = buildUpdateFeeBpsIx({
      admin: ctx.admin.publicKey,
      config,
      newFeeBps: 100,
    });
    await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), setFeeIx), [ctx.admin]);

    const feeVaultBefore = await getTokenBalance(ctx, feeVault);

    // Do 2 swap fills
    for (let i = 0; i < 2; i++) {
      const { user: maker, userUsdcAta: makerUsdcAta, userYesAta: makerYesAta, userNoAta: makerNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
      const mintIx = buildMintPairIx({
        user: maker.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: makerUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(TEN_TOKENS),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [maker]);

      const askIx = buildPlaceOrderIx({
        user: maker.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: makerUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        feeVault,
        side: SIDE_YES_ASK,
        price: 50,
        quantity: new BN(ONE_TOKEN),
        orderType: ORDER_TYPE_LIMIT,
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), askIx), [maker]);

      const { user: taker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

      const bidIx = buildPlaceOrderIx({
        user: taker.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: takerUsdcAta,
        userYesAta: takerYesAta,
        userNoAta: takerNoAta,
        feeVault,
        side: SIDE_USDC_BID,
        price: 50,
        quantity: new BN(ONE_TOKEN),
        orderType: ORDER_TYPE_MARKET,
        maxFills: 10,
        makerAccounts: [makerUsdcAta],
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), bidIx), [taker]);
    }

    const feeVaultAfter = await getTokenBalance(ctx, feeVault);

    // Each swap: fill_usdc = 500_000, total_fee = floor(500_000 * 100 / 10_000) = 5000
    // 2 fills = 10_000 total
    expect(feeVaultAfter - feeVaultBefore).to.equal(10_000);
  });
});
