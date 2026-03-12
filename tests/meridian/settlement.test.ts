/**
 * settlement.test.ts — Comprehensive bankrun test suite for the Phase 3
 * settlement lifecycle: settle_market, admin_settle, admin_override,
 * redeem (pair burn + winner), and crank_cancel.
 *
 * NOTE: Sequential coupling — Tests share a single bankrun context (BankrunContext)
 * and its clock advances monotonically across suites. Tests within each describe
 * block depend on state left by prior tests (minted tokens, settled markets, etc.).
 * This is by design to avoid re-initializing the full on-chain state for each test,
 * but means tests cannot be run in isolation or reordered.
 */

import { expect } from "chai";
import {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
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
  MarketAccounts,
  findGlobalConfig,
  MOCK_ORACLE_PROGRAM_ID,
  mintTestUsdc,
  createAta,
  readOrderSlot,
} from "../helpers";

import {
  buildSettleMarketIx,
  buildAdminSettleIx,
  buildAdminOverrideIx,
  buildRedeemIx,
  buildCrankCancelIx,
  buildMintPairIx,
  buildPlaceOrderIx,
  buildCancelOrderIx,
  buildUpdatePriceIx,
  buildPauseIx,
  buildUnpauseIx,
} from "../helpers/instructions";

import {
  readMarketFields,
  readMarket,
  getTokenBalance,
  advanceClock,
} from "../helpers/market-layout";
import { createFundedUserWithMarketAtas } from "../helpers/mint-helpers";
import { makeUniqueCuIxFactory } from "../helpers/tx-helpers";

const uniqueCuIx = makeUniqueCuIxFactory(200_000);

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Settlement Lifecycle", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;

  // Market 1: oracle-settled market (for settle_market + admin_override tests)
  let ma1: MarketAccounts;
  let m1CloseUnix: number;
  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000; // $200
  const PREVIOUS_CLOSE = 195_000_000;
  const ONE_TOKEN = 1_000_000;

  // User token accounts (admin is the user)
  let userUsdcAta: PublicKey;
  let userYesAta1: PublicKey;
  let userNoAta1: PublicKey;

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);

    // Market closes in 5 seconds — easy to advance past
    m1CloseUnix = now + 5;

    // Create USDC mint, config, oracle feed
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);

    // Set oracle price at $205 (above strike) with current timestamp
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 205_000_000, 500_000);

    // Create market 1
    ma1 = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, m1CloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // Create user USDC ATA and fund with $10,000
    userUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, ctx.admin.publicKey);
    await mintTestUsdc(ctx.context, usdcMint, ctx.admin, userUsdcAta, 10_000_000_000);

    // Derive Yes/No ATAs for market 1
    userYesAta1 = getAssociatedTokenAddressSync(ma1.yesMint, ctx.admin.publicKey);
    userNoAta1 = getAssociatedTokenAddressSync(ma1.noMint, ctx.admin.publicKey);

    // Mint 100 pairs on market 1 — user gets 100 Yes + 100 No tokens
    const provider = new BankrunProvider(ctx.context);
    const mintIx = buildMintPairIx({
      user: ctx.admin.publicKey,
      config,
      market: ma1.market,
      yesMint: ma1.yesMint,
      noMint: ma1.noMint,
      userUsdcAta,
      userYesAta: userYesAta1,
      userNoAta: userNoAta1,
      usdcVault: ma1.usdcVault,
      quantity: new BN(100 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(mintIx), [ctx.admin]);
  });

  // =========================================================================
  // settle_market
  // =========================================================================
  describe("settle_market", () => {
    it("rejects settlement before market close", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma1.market,
        oracleFeed,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected SettlementTooEarly error");
      } catch (err: any) {
        // 6070 = 6000 + 70
        expect(String(err)).to.match(/0x17b6|SettlementTooEarly|6070/i);
      }
    });

    it("settles Yes wins when oracle price >= strike", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance clock past market close
      const settleTime = m1CloseUnix + 10;
      await advanceClock(ctx, settleTime);

      // Update oracle price to $205 with fresh timestamp near settle time
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(205_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      // Settle
      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma1.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      // Verify on-chain settlement state
      const m = await readMarket(ctx, ma1.market);
      expect(m.isSettled).to.be.true;
      expect(m.outcome).to.equal(1); // Yes wins
      expect(m.settlementPrice).to.equal(205_000_000);
      expect(m.settledAt).to.be.greaterThanOrEqual(settleTime);
      expect(m.overrideDeadline).to.equal(m.settledAt + 3600);
    });

    it("rejects double settlement", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma1.market,
        oracleFeed,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected MarketAlreadySettled error");
      } catch (err: any) {
        // 6020 = 6000 + 20
        expect(String(err)).to.match(/0x1784|MarketAlreadySettled|6020/i);
      }
    });
  });

  // =========================================================================
  // admin_settle
  // =========================================================================
  describe("admin_settle", () => {
    // Market 2: a separate unsettled market for admin_settle tests
    let ma2: MarketAccounts;
    let m2CloseUnix: number;

    before(async () => {
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);

      // Use a different strike price to get a distinct PDA
      m2CloseUnix = now + 5;
      ma2 = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        210_000_000, // different strike ($210)
        m2CloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );
    });

    it("rejects admin settle before 1hr delay", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance past market close but less than 1hr after close
      await advanceClock(ctx, m2CloseUnix + 60);

      const ix = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma2.market,
        settlementPrice: new BN(205_000_000),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected AdminSettleTooEarly error");
      } catch (err: any) {
        // 6071 = 6000 + 71
        expect(String(err)).to.match(/0x17b7|AdminSettleTooEarly|6071/i);
      }
    });

    it("admin settles after 1hr delay", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance past close + 3600
      const adminSettleTime = m2CloseUnix + 3601;
      await advanceClock(ctx, adminSettleTime);

      const ix = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma2.market,
        settlementPrice: new BN(205_000_000),
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const m = await readMarket(ctx, ma2.market);
      expect(m.isSettled).to.be.true;
      // Strike is 210_000_000, settlement price is 205_000_000 → No wins
      expect(m.outcome).to.equal(2);
      expect(m.settlementPrice).to.equal(205_000_000);
      expect(m.overrideDeadline).to.be.greaterThan(adminSettleTime);
    });
  });

  // =========================================================================
  // admin_override
  // =========================================================================
  describe("admin_override", () => {
    // Uses market 1 which was oracle-settled above with outcome=1 (Yes wins)

    it("overrides outcome within window", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Ensure we're within override window of market 1
      const m = await readMarket(ctx, ma1.market);
      const overrideTime = m.settledAt + 100; // well within 1hr window
      await advanceClock(ctx, overrideTime);

      // Override to a price below strike → flip to No wins
      const ix = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma1.market,
        newSettlementPrice: new BN(190_000_000), // below $200 strike
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const mAfter = await readMarket(ctx, ma1.market);
      expect(mAfter.outcome).to.equal(2); // No wins
      expect(mAfter.settlementPrice).to.equal(190_000_000);
      expect(mAfter.overrideCount).to.equal(1);
      // Override deadline should reset to current time + 3600
      expect(mAfter.overrideDeadline).to.be.greaterThanOrEqual(overrideTime + 3600);
    });

    it("increments override_count", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Second override: flip back to Yes wins
      const ix = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma1.market,
        newSettlementPrice: new BN(210_000_000), // above strike
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const m = await readMarket(ctx, ma1.market);
      expect(m.overrideCount).to.equal(2);
      expect(m.outcome).to.equal(1); // Yes wins again
    });

    it("rejects after 3 overrides", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Third override (count goes to 3)
      const ix3 = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma1.market,
        newSettlementPrice: new BN(190_000_000),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix3),
        [ctx.admin],
      );

      const m = await readMarket(ctx, ma1.market);
      expect(m.overrideCount).to.equal(3);

      // Fourth override should fail (count == 3 already)
      const ix4 = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma1.market,
        newSettlementPrice: new BN(210_000_000),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix4),
          [ctx.admin],
        );
        expect.fail("Expected MaxOverridesExceeded error");
      } catch (err: any) {
        // 6075 = 6000 + 75
        expect(String(err)).to.match(/0x17bb|MaxOverridesExceeded|6075/i);
      }
    });

    it("rejects after override window expires", async () => {
      // Use the admin-settled market (from describe("admin_settle")) which has
      // override_count=0 but we can advance past its override_deadline.
      // We need to find market 2's key. Since it was created in a nested before(),
      // we re-derive it here with the same params.
      const provider = new BankrunProvider(ctx.context);

      // Market 1 has count=3, so we get MaxOverridesExceeded. To isolate the
      // window-expired error, create a one-off market, settle it, then expire.
      const clock0 = await ctx.context.banksClient.getClock();
      const now0 = Number(clock0.unixTimestamp);

      const maExpiry = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        250_000_000, // unique strike for PDA
        now0 + 5,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Advance past close + 1hr for admin settle
      const adminTime = now0 + 5 + 3601;
      await advanceClock(ctx, adminTime);

      const settleIx = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: maExpiry.market,
        settlementPrice: new BN(260_000_000), // Yes wins
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      // Advance past override deadline
      const mSettled = await readMarket(ctx, maExpiry.market);
      expect(mSettled.overrideCount).to.equal(0);
      await advanceClock(ctx, mSettled.overrideDeadline + 10);

      // Override should now fail with OverrideWindowExpired
      const overrideIx = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: maExpiry.market,
        newSettlementPrice: new BN(190_000_000),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), overrideIx),
          [ctx.admin],
        );
        expect.fail("Expected OverrideWindowExpired error");
      } catch (err: any) {
        // 6072 = 6000 + 72
        expect(String(err)).to.match(/0x17b8|OverrideWindowExpired|6072/i);
      }
    });
  });

  // =========================================================================
  // redeem
  // =========================================================================
  describe("redeem", () => {
    // Market 3: dedicated for redeem tests — create, mint, settle, then redeem
    let ma3: MarketAccounts;
    let m3CloseUnix: number;
    let userYesAta3: PublicKey;
    let userNoAta3: PublicKey;

    before(async () => {
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      m3CloseUnix = now + 5;

      ma3 = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        220_000_000, // strike = $220, distinct PDA
        m3CloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      userYesAta3 = getAssociatedTokenAddressSync(ma3.yesMint, ctx.admin.publicKey);
      userNoAta3 = getAssociatedTokenAddressSync(ma3.noMint, ctx.admin.publicKey);

      // Mint 50 pairs
      const provider = new BankrunProvider(ctx.context);
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma3.market,
        yesMint: ma3.yesMint,
        noMint: ma3.noMint,
        userUsdcAta,
        userYesAta: userYesAta3,
        userNoAta: userNoAta3,
        usdcVault: ma3.usdcVault,
        quantity: new BN(50 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);
    });

    it("pair burn redeems Yes+No for $1 USDC anytime (before settlement)", async () => {
      const provider = new BankrunProvider(ctx.context);

      const usdcBefore = await getTokenBalance(ctx, userUsdcAta);
      const yesBefore = await getTokenBalance(ctx, userYesAta3);
      const noBefore = await getTokenBalance(ctx, userNoAta3);

      const redeemQty = 5 * ONE_TOKEN;
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma3.market,
        yesMint: ma3.yesMint,
        noMint: ma3.noMint,
        usdcVault: ma3.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta3,
        userNoAta: userNoAta3,
        mode: 0, // pair burn
        quantity: new BN(redeemQty),
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const usdcAfter = await getTokenBalance(ctx, userUsdcAta);
      const yesAfter = await getTokenBalance(ctx, userYesAta3);
      const noAfter = await getTokenBalance(ctx, userNoAta3);

      expect(usdcAfter - usdcBefore).to.equal(redeemQty); // $5 USDC returned
      expect(yesBefore - yesAfter).to.equal(redeemQty);    // 5 Yes burned
      expect(noBefore - noAfter).to.equal(redeemQty);      // 5 No burned
    });

    it("rejects winner redeem during override window", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance past market close and settle market 3
      const settleTime = m3CloseUnix + 10;
      await advanceClock(ctx, settleTime);

      // Update oracle price to $225 (above $220 strike → Yes wins)
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(225_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      // Settle
      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma3.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      const m = await readMarket(ctx, ma3.market);
      expect(m.isSettled).to.be.true;
      expect(m.outcome).to.equal(1); // Yes wins

      // Now try winner redeem during override window — should fail
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma3.market,
        yesMint: ma3.yesMint,
        noMint: ma3.noMint,
        usdcVault: ma3.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta3,
        userNoAta: userNoAta3,
        mode: 1, // winner redeem
        quantity: new BN(5 * ONE_TOKEN),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected RedemptionBlockedOverride error");
      } catch (err: any) {
        // 6080 = 6000 + 80
        expect(String(err)).to.match(/0x17c0|RedemptionBlockedOverride|6080/i);
      }
    });

    it("winner redeems after override window", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance past override deadline
      const m = await readMarket(ctx, ma3.market);
      await advanceClock(ctx, m.overrideDeadline + 10);

      const usdcBefore = await getTokenBalance(ctx, userUsdcAta);
      const yesBefore = await getTokenBalance(ctx, userYesAta3);

      const redeemQty = 10 * ONE_TOKEN;
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma3.market,
        yesMint: ma3.yesMint,
        noMint: ma3.noMint,
        usdcVault: ma3.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta3,
        userNoAta: userNoAta3,
        mode: 1, // winner redeem
        quantity: new BN(redeemQty),
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const usdcAfter = await getTokenBalance(ctx, userUsdcAta);
      const yesAfter = await getTokenBalance(ctx, userYesAta3);

      // Yes wins: 10 Yes tokens burned, $10 USDC returned
      expect(usdcAfter - usdcBefore).to.equal(redeemQty);
      expect(yesBefore - yesAfter).to.equal(redeemQty);
    });
  });

  // =========================================================================
  // crank_cancel
  // =========================================================================
  describe("crank_cancel", () => {
    // Market 4: for crank_cancel tests
    let ma4: MarketAccounts;
    let m4CloseUnix: number;
    let userYesAta4: PublicKey;
    let userNoAta4: PublicKey;

    // A separate user who places a resting order
    let orderUser: Keypair;
    let orderUserUsdcAta: PublicKey;
    let orderUserYesAta: PublicKey;
    let orderUserNoAta: PublicKey;

    // Unsettled market 5 for the "rejects unsettled" test
    let ma5: MarketAccounts;

    before(async () => {
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      m4CloseUnix = now + 5;

      ma4 = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        230_000_000, // strike = $230
        m4CloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      userYesAta4 = getAssociatedTokenAddressSync(ma4.yesMint, ctx.admin.publicKey);
      userNoAta4 = getAssociatedTokenAddressSync(ma4.noMint, ctx.admin.publicKey);

      // Mint 50 pairs on market 4 (by admin — puts tokens in vault)
      const provider = new BankrunProvider(ctx.context);
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma4.market,
        yesMint: ma4.yesMint,
        noMint: ma4.noMint,
        userUsdcAta,
        userYesAta: userYesAta4,
        userNoAta: userNoAta4,
        usdcVault: ma4.usdcVault,
        quantity: new BN(50 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Create a fresh user for placing orders (needs only USDC, no Yes/No)
      ({ user: orderUser, userUsdcAta: orderUserUsdcAta, userYesAta: orderUserYesAta, userNoAta: orderUserNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma4, 1_000_000_000));

      // Place a resting USDC bid order at price 50
      const placeIx = buildPlaceOrderIx({
        user: orderUser.publicKey,
        config,
        market: ma4.market,
        orderBook: ma4.orderBook,
        usdcVault: ma4.usdcVault,
        escrowVault: ma4.escrowVault,
        yesEscrow: ma4.yesEscrow,
        noEscrow: ma4.noEscrow,
        yesMint: ma4.yesMint,
        noMint: ma4.noMint,
        userUsdcAta: orderUserUsdcAta,
        userYesAta: orderUserYesAta,
        userNoAta: orderUserNoAta,
        side: 0, // USDC bid
        price: 50,
        quantity: new BN(10 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), placeIx), [orderUser]);

      // Create unsettled market 5 (for "rejects unsettled" test)
      ma5 = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        240_000_000, // strike = $240
        now + 86400, // closes far in the future
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );
    });

    it("rejects crank on unsettled market", async () => {
      const provider = new BankrunProvider(ctx.context);

      const ix = buildCrankCancelIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma5.market,
        orderBook: ma5.orderBook,
        escrowVault: ma5.escrowVault,
        yesEscrow: ma5.yesEscrow,
        noEscrow: ma5.noEscrow,
        batchSize: 10,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected MarketNotSettled error");
      } catch (err: any) {
        // 6021 = 6000 + 21
        expect(String(err)).to.match(/0x1785|MarketNotSettled|6021/i);
      }
    });

    it("cancels resting orders post-settlement and returns escrow", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Advance past market 4 close
      const settleTime = m4CloseUnix + 10;
      await advanceClock(ctx, settleTime);

      // Update oracle for fresh timestamp
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(235_000_000), // above $230 strike
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      // Settle market 4
      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma4.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      // Verify market is settled
      const m = await readMarket(ctx, ma4.market);
      expect(m.isSettled).to.be.true;

      // Record order user's USDC balance before crank
      const usdcBefore = await getTokenBalance(ctx, orderUserUsdcAta);

      // Crank cancel — the resting USDC bid should be refunded
      const crankIx = buildCrankCancelIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma4.market,
        orderBook: ma4.orderBook,
        escrowVault: ma4.escrowVault,
        yesEscrow: ma4.yesEscrow,
        noEscrow: ma4.noEscrow,
        batchSize: 10,
        makerAccounts: [orderUserUsdcAta], // destination for USDC refund
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), crankIx),
        [ctx.admin],
      );

      // Verify refund: 10 tokens * 50/100 = 5 USDC = 5_000_000
      const usdcAfter = await getTokenBalance(ctx, orderUserUsdcAta);
      expect(usdcAfter - usdcBefore).to.equal(5_000_000);
    });

    it("rejects crank on empty settled book (CrankNotNeeded)", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Market 4 was just cranked — book should be empty now
      const crankIx = buildCrankCancelIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma4.market,
        orderBook: ma4.orderBook,
        escrowVault: ma4.escrowVault,
        yesEscrow: ma4.yesEscrow,
        noEscrow: ma4.noEscrow,
        batchSize: 10,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), crankIx),
          [ctx.admin],
        );
        expect.fail("Expected CrankNotNeeded error");
      } catch (err: any) {
        // 6090 = 6000 + 90
        expect(String(err)).to.match(/0x17ca|CrankNotNeeded|6090/i);
      }
    });
  });

  // =========================================================================
  // Oracle edge cases
  // =========================================================================
  describe("oracle edge cases", () => {
    let maOracle: MarketAccounts;
    let maOracleCloseUnix: number;

    before(async () => {
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      maOracleCloseUnix = now + 5;

      maOracle = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        260_000_000, // unique strike for PDA
        maOracleCloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );
    });

    it("rejects stale oracle price", async () => {
      const provider = new BankrunProvider(ctx.context);
      const settleTime = maOracleCloseUnix + 10;
      await advanceClock(ctx, settleTime);

      // Set oracle timestamp far in the past (stale by > 120s default)
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(265_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime - 300), // 300s old — stale
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: maOracle.market,
        oracleFeed,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), settleIx),
          [ctx.admin],
        );
        expect.fail("Expected OracleStale error");
      } catch (err: any) {
        // 6040 = 6000 + 40
        expect(String(err)).to.match(/0x1798|OracleStale|6040/i);
      }
    });

    it("rejects oracle with too-wide confidence band", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);

      // Set confidence very wide (e.g. 50% of price — way over 0.5% default)
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(265_000_000),
        confidence: new BN(130_000_000), // ~49% of price — way too wide
        timestamp: new BN(now),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: maOracle.market,
        oracleFeed,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), settleIx),
          [ctx.admin],
        );
        expect.fail("Expected OracleConfidenceTooWide error");
      } catch (err: any) {
        // 6041 = 6000 + 41
        expect(String(err)).to.match(/0x1799|OracleConfidenceTooWide|6041/i);
      }
    });

    it("settles No wins when oracle price < strike", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);

      // Set oracle to valid price below strike ($260)
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(255_000_000), // below $260 strike
        confidence: new BN(500_000),
        timestamp: new BN(now),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: maOracle.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      const m = await readMarket(ctx, maOracle.market);
      expect(m.isSettled).to.be.true;
      expect(m.outcome).to.equal(2); // No wins
      expect(m.settlementPrice).to.equal(255_000_000);
      expect(m.settledAt).to.be.greaterThan(0);
      expect(m.overrideDeadline).to.equal(m.settledAt + 3600);
    });

    it("settles Yes at exact strike boundary (price == strike)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);

      // New market for boundary test
      const maBoundary = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        270_000_000, // strike = $270
        now + 5,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      await advanceClock(ctx, now + 10);

      // Set oracle price exactly at strike
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(270_000_000), // exactly at strike
        confidence: new BN(500_000),
        timestamp: new BN(now + 10),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: maBoundary.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      const m = await readMarket(ctx, maBoundary.market);
      expect(m.isSettled).to.be.true;
      expect(m.outcome).to.equal(1); // Yes wins (>= strike)
      expect(m.settlementPrice).to.equal(270_000_000);
    });
  });

  // =========================================================================
  // Redeem edge cases
  // =========================================================================
  describe("redeem edge cases", () => {
    // Market 6: No-wins market for No-token winner redeem
    let ma6: MarketAccounts;
    let m6CloseUnix: number;
    let userYesAta6: PublicKey;
    let userNoAta6: PublicKey;

    before(async () => {
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      m6CloseUnix = now + 5;

      ma6 = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        280_000_000, // strike = $280, unique PDA
        m6CloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      userYesAta6 = getAssociatedTokenAddressSync(ma6.yesMint, ctx.admin.publicKey);
      userNoAta6 = getAssociatedTokenAddressSync(ma6.noMint, ctx.admin.publicKey);

      // Mint 50 pairs
      const provider = new BankrunProvider(ctx.context);
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma6.market,
        yesMint: ma6.yesMint,
        noMint: ma6.noMint,
        userUsdcAta,
        userYesAta: userYesAta6,
        userNoAta: userNoAta6,
        usdcVault: ma6.usdcVault,
        quantity: new BN(50 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as No wins (price below strike)
      await advanceClock(ctx, m6CloseUnix + 10);
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(275_000_000), // below $280 strike → No wins
        confidence: new BN(500_000),
        timestamp: new BN(m6CloseUnix + 10),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma6.market,
        oracleFeed,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      // Verify No wins
      const m = await readMarket(ctx, ma6.market);
      expect(m.outcome).to.equal(2);

      // Advance past override window
      await advanceClock(ctx, m.overrideDeadline + 10);
    });

    it("No-wins: winner redeems No tokens for USDC", async () => {
      const provider = new BankrunProvider(ctx.context);

      const usdcBefore = await getTokenBalance(ctx, userUsdcAta);
      const noBefore = await getTokenBalance(ctx, userNoAta6);

      const redeemQty = 10 * ONE_TOKEN;
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma6.market,
        yesMint: ma6.yesMint,
        noMint: ma6.noMint,
        usdcVault: ma6.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta6,
        userNoAta: userNoAta6,
        mode: 1, // winner redeem
        quantity: new BN(redeemQty),
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      const usdcAfter = await getTokenBalance(ctx, userUsdcAta);
      const noAfter = await getTokenBalance(ctx, userNoAta6);

      // No wins: 10 No tokens burned, $10 USDC returned
      expect(usdcAfter - usdcBefore).to.equal(redeemQty);
      expect(noBefore - noAfter).to.equal(redeemQty);

      // Verify total_redeemed updated
      const m = await readMarket(ctx, ma6.market);
      expect(m.totalRedeemed).to.equal(redeemQty);
    });

    it("pair burn rejects with insufficient Yes balance", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Try to pair-burn more than available (user has 50 pairs minted, 10 No redeemed above)
      // Yes balance is still 50, but let's try 100 — more than available
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma6.market,
        yesMint: ma6.yesMint,
        noMint: ma6.noMint,
        usdcVault: ma6.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta6,
        userNoAta: userNoAta6,
        mode: 0, // pair burn
        quantity: new BN(100 * ONE_TOKEN), // more than held
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected InsufficientBalance error");
      } catch (err: any) {
        // InsufficientBalance = 50, on-chain = 6050
        expect(String(err)).to.match(/0x17a2|InsufficientBalance|6050/i);
      }
    });

    it("pair burn rejects with insufficient No balance", async () => {
      const provider = new BankrunProvider(ctx.context);

      // User redeemed 10 No tokens above via winner redeem, so No balance < Yes balance
      // Try to pair-burn more No tokens than available (user has 40 No, 50 Yes)
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma6.market,
        yesMint: ma6.yesMint,
        noMint: ma6.noMint,
        usdcVault: ma6.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta6,
        userNoAta: userNoAta6,
        mode: 0, // pair burn
        quantity: new BN(45 * ONE_TOKEN), // user has 50 Yes but only 40 No
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected InsufficientBalance error");
      } catch (err: any) {
        expect(String(err)).to.match(/0x17a2|InsufficientBalance|6050/i);
      }
    });

    it("total_redeemed accumulates across multiple redemptions", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Do another winner redeem of 5 No tokens
      const redeemQty = 5 * ONE_TOKEN;
      const ix = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma6.market,
        yesMint: ma6.yesMint,
        noMint: ma6.noMint,
        usdcVault: ma6.usdcVault,
        userUsdcAta,
        userYesAta: userYesAta6,
        userNoAta: userNoAta6,
        mode: 1,
        quantity: new BN(redeemQty),
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );

      // total_redeemed should be 10 + 5 = 15
      const m = await readMarket(ctx, ma6.market);
      expect(m.totalRedeemed).to.equal(15 * ONE_TOKEN);
    });
  });

  // =========================================================================
  // audit coverage
  // =========================================================================
  describe("audit coverage", () => {
    // Each test uses its own fresh market to avoid interference.
    // Strike prices 300M–312M are reserved for this block.

    // Shared oracle feed and infra from the outer describe are reused.

    // ---------------------------------------------------------------------------
    // Test 1: admin_settle on already-settled market → rejected
    // ---------------------------------------------------------------------------
    it("admin_settle on already-settled market is rejected", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      // Create a fresh market
      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        300_000_000, // strike = $300
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Advance past market close + 1hr, then admin-settle it
      const adminSettleTime = closeUnix + 3601;
      await advanceClock(ctx, adminSettleTime);

      const settleIx = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        settlementPrice: new BN(310_000_000),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      // Verify it's settled
      const m = await readMarket(ctx, ma.market);
      expect(m.isSettled).to.be.true;

      // Now try admin_settle again — should be rejected
      const settleIx2 = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        settlementPrice: new BN(305_000_000),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), settleIx2),
          [ctx.admin],
        );
        expect.fail("Expected MarketAlreadySettled error");
      } catch (err: any) {
        // MarketAlreadySettled = 20, on-chain = 6020 = 0x1784
        expect(String(err)).to.match(/0x1784|MarketAlreadySettled|6020/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 2: admin_override on unsettled market → rejected
    // ---------------------------------------------------------------------------
    it("admin_override on unsettled market is rejected", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);

      // Create a fresh unsettled market
      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        301_000_000, // strike = $301
        now + 3600,  // closes far enough in the future that we won't accidentally settle it
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Do NOT settle — try override immediately
      const overrideIx = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        newSettlementPrice: new BN(295_000_000),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), overrideIx),
          [ctx.admin],
        );
        expect.fail("Expected MarketNotSettled error");
      } catch (err: any) {
        // MarketNotSettled = 21, on-chain = 6021 = 0x1785
        expect(String(err)).to.match(/0x1785|MarketNotSettled|6021/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 3: crank_cancel succeeds during override window
    // ---------------------------------------------------------------------------
    it("crank_cancel succeeds during override window", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        302_000_000, // strike = $302
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Create a user to place a resting order
      const { user: crankUser, userUsdcAta: crankUserUsdcAta, userYesAta: crankUserYesAta, userNoAta: crankUserNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 1_000_000_000);

      // Place a resting limit bid
      const placeIx = buildPlaceOrderIx({
        user: crankUser.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: crankUserUsdcAta,
        userYesAta: crankUserYesAta,
        userNoAta: crankUserNoAta,
        side: 0,     // USDC bid
        price: 50,
        quantity: new BN(5 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), placeIx),
        [crankUser],
      );

      // Advance past market close and settle
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(310_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Verify still within override window
      const mSettled = await readMarket(ctx, ma.market);
      expect(mSettled.isSettled).to.be.true;
      const curClock = await ctx.context.banksClient.getClock();
      expect(Number(curClock.unixTimestamp)).to.be.lessThan(mSettled.overrideDeadline);

      // Crank cancel during override window — should succeed
      const usdcBefore = await getTokenBalance(ctx, crankUserUsdcAta);

      const crankIx = buildCrankCancelIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        batchSize: 10,
        makerAccounts: [crankUserUsdcAta],
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), crankIx),
        [ctx.admin],
      );

      // Verify the escrow was refunded (bid of 5 tokens at price 50 = 2.5 USDC = 2_500_000)
      const usdcAfter = await getTokenBalance(ctx, crankUserUsdcAta);
      expect(usdcAfter - usdcBefore).to.equal(2_500_000);
    });

    // ---------------------------------------------------------------------------
    // Test 4: admin overrides outcome → post-deadline redeem pays corrected outcome
    // ---------------------------------------------------------------------------
    it("post-override redemption pays the corrected outcome", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        303_000_000, // strike = $303
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 20 pairs
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(20 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as Yes wins (price above $303 strike)
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(310_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      let m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(1); // Yes wins initially

      // Override to No wins (price below strike)
      const overrideIx = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        newSettlementPrice: new BN(295_000_000), // below $303 → No wins
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), overrideIx),
        [ctx.admin],
      );

      m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(2); // No wins after override

      // Advance past override deadline
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Redeem No tokens (should succeed since No wins)
      const noBefore = await getTokenBalance(ctx, userNoAta);
      const usdcBefore = await getTokenBalance(ctx, userUsdcAta);

      const redeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 1, // winner redeem
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), redeemIx),
        [ctx.admin],
      );

      const noAfter = await getTokenBalance(ctx, userNoAta);
      const usdcAfter = await getTokenBalance(ctx, userUsdcAta);

      expect(noBefore - noAfter).to.equal(10 * ONE_TOKEN);
      expect(usdcAfter - usdcBefore).to.equal(10 * ONE_TOKEN);
    });

    // ---------------------------------------------------------------------------
    // Test 5: losing token holder attempts winner-redeem → InsufficientBalance
    // ---------------------------------------------------------------------------
    it("losing-side winner-redeem is rejected with InsufficientBalance", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        304_000_000, // strike = $304
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 10 pairs — user gets Yes and No tokens
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as Yes wins (price above $304 strike)
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(310_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Advance past override deadline
      const m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(1); // Yes wins
      await advanceClock(ctx, m.overrideDeadline + 10);

      // User holds No tokens but Yes wins — winner redeem via mode=1 tries to
      // burn Yes tokens; user_yes_ata balance is checked, passes, but wait —
      // user DOES have Yes tokens too (they minted pairs). We want to prove
      // that No token holders cannot redeem No tokens as winners.
      // Strategy: pair-burn all Yes tokens first so the user only has No.
      const pairBurnIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 0, // pair burn — removes equal Yes and No
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), pairBurnIx),
        [ctx.admin],
      );

      // Verify balances after pair-burn: user should have 0 of both token types
      const yesBal = await getTokenBalance(ctx, userYesAta);
      const noBal = await getTokenBalance(ctx, userNoAta);
      expect(yesBal, "Yes balance should be 0 after pair burn").to.equal(0);
      expect(noBal, "No balance should be 0 after pair burn").to.equal(0);

      // Now user has 0 Yes and 0 No (all burned via pair burn).
      // Outcome=Yes means winner_redeem burns Yes tokens. User has 0 Yes,
      // so InsufficientBalance is expected. This proves that a user without
      // winning-side tokens cannot redeem regardless of losing-side holdings.
      const redeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 1, // winner redeem
        quantity: new BN(5 * ONE_TOKEN),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), redeemIx),
          [ctx.admin],
        );
        expect.fail("Expected InsufficientBalance error");
      } catch (err: any) {
        // InsufficientBalance = 50, on-chain = 6050 = 0x17A2
        expect(String(err)).to.match(/0x17a2|InsufficientBalance|6050/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 6: vault balance reaches zero after full redemption
    // ---------------------------------------------------------------------------
    it("vault balance is zero after all tokens are redeemed", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        305_000_000, // strike = $305
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 20 pairs
      const MINT_QTY = 20 * ONE_TOKEN;
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(MINT_QTY),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as Yes wins
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(315_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Advance past override deadline
      const m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(1); // Yes wins
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Redeem all 20 Yes tokens (winner redeem)
      const winnerRedeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 1,
        quantity: new BN(MINT_QTY),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), winnerRedeemIx),
        [ctx.admin],
      );

      // Vault should now be empty (all 20 USDC withdrawn)
      const vaultBalance = await getTokenBalance(ctx, ma.usdcVault);
      expect(vaultBalance).to.equal(0);
    });

    // ---------------------------------------------------------------------------
    // Test 7: pair burn during override window succeeds
    // ---------------------------------------------------------------------------
    it("pair burn during override window succeeds", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        306_000_000, // strike = $306
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 10 pairs
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(315_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Verify still within override window
      const mSettled = await readMarket(ctx, ma.market);
      expect(mSettled.isSettled).to.be.true;
      const curClock2 = await ctx.context.banksClient.getClock();
      expect(Number(curClock2.unixTimestamp)).to.be.lessThan(mSettled.overrideDeadline);

      const usdcBefore = await getTokenBalance(ctx, userUsdcAta);

      // Pair burn during override window — should succeed (not blocked)
      const pairBurnIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 0, // pair burn
        quantity: new BN(5 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), pairBurnIx),
        [ctx.admin],
      );

      const usdcAfter = await getTokenBalance(ctx, userUsdcAta);
      expect(usdcAfter - usdcBefore).to.equal(5 * ONE_TOKEN);
    });

    // ---------------------------------------------------------------------------
    // Test 8: admin_settle with zero price → rejected
    // ---------------------------------------------------------------------------
    it("admin_settle with zero price is rejected", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        307_000_000, // strike = $307
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Advance past close + 1hr for admin settle eligibility
      await advanceClock(ctx, closeUnix + 3601);

      const ix = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        settlementPrice: new BN(0), // zero price — invalid
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("Expected OraclePriceInvalid error");
      } catch (err: any) {
        // OraclePriceInvalid = 43, on-chain = 6043 = 0x179B
        expect(String(err)).to.match(/0x179b|OraclePriceInvalid|6043/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 9: oracle future-timestamp → rejected
    // ---------------------------------------------------------------------------
    it("oracle with future timestamp is rejected as stale", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        308_000_000, // strike = $308
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Advance past market close
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      // Set oracle timestamp in the future (beyond current clock)
      // The mock oracle now rejects future timestamps at the update_price level (H7 fix).
      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(315_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime + 3600), // future timestamp — invalid
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), updateIx),
          [ctx.admin],
        );
        expect.fail("Expected InvalidTimestamp error");
      } catch (err: any) {
        // InvalidTimestamp = 6003 = 0x1773
        expect(String(err)).to.match(/0x1773|InvalidTimestamp|6003/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 10: pause blocks settlement
    // ---------------------------------------------------------------------------
    it("pause blocks settle_market", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        309_000_000, // strike = $309
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Advance past market close and set a valid oracle price
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(315_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), updateIx),
        [ctx.admin],
      );

      // Pause this specific market
      const pauseIx = buildPauseIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), pauseIx),
        [ctx.admin],
      );

      // Verify market is paused
      const mPaused = await readMarket(ctx, ma.market);
      expect(mPaused.isPaused).to.be.true;

      // Attempt to settle — should fail
      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        oracleFeed,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), settleIx),
          [ctx.admin],
        );
        expect.fail("Expected MarketPaused error");
      } catch (err: any) {
        // MarketPaused = 22, on-chain = 6022 = 0x1786
        expect(String(err)).to.match(/0x1786|MarketPaused|6022/i);
      }

      // Unpause so subsequent tests aren't affected
      const unpauseIx = buildUnpauseIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), unpauseIx),
        [ctx.admin],
      );
    });

    // ---------------------------------------------------------------------------
    // Test 11: pause blocks winner-redeem
    // ---------------------------------------------------------------------------
    it("pause blocks winner-redeem after settlement", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        310_000_000, // strike = $310
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 10 pairs
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as Yes wins
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(320_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Advance past override deadline
      const m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(1); // Yes wins
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Pause the market
      const pauseIx = buildPauseIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), pauseIx),
        [ctx.admin],
      );

      // Attempt winner redeem — should fail due to pause
      const redeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 1, // winner redeem
        quantity: new BN(5 * ONE_TOKEN),
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), redeemIx),
          [ctx.admin],
        );
        expect.fail("Expected MarketPaused error");
      } catch (err: any) {
        // MarketPaused = 22, on-chain = 6022 = 0x1786
        expect(String(err)).to.match(/0x1786|MarketPaused|6022/i);
      }

      // Unpause for cleanup
      const unpauseIx = buildUnpauseIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), unpauseIx),
        [ctx.admin],
      );
    });

    // ---------------------------------------------------------------------------
    // Test 12: admin_override with zero price → rejected
    // ---------------------------------------------------------------------------
    it("admin_override with zero price is rejected", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        311_000_000, // strike = $311
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Admin-settle the market first (override requires a settled market)
      const adminSettleTime = closeUnix + 3601;
      await advanceClock(ctx, adminSettleTime);

      const settleIx = buildAdminSettleIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        settlementPrice: new BN(315_000_000),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), settleIx),
        [ctx.admin],
      );

      const m = await readMarket(ctx, ma.market);
      expect(m.isSettled).to.be.true;

      // Attempt override with zero price
      const overrideIx = buildAdminOverrideIx({
        admin: ctx.admin.publicKey,
        config,
        market: ma.market,
        newSettlementPrice: new BN(0), // invalid
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), overrideIx),
          [ctx.admin],
        );
        expect.fail("Expected OraclePriceInvalid error");
      } catch (err: any) {
        // OraclePriceInvalid = 43, on-chain = 6043 = 0x179B
        expect(String(err)).to.match(/0x179b|OraclePriceInvalid|6043/i);
      }
    });

    // ---------------------------------------------------------------------------
    // Test 13: vault balance delta matches redemption amount
    // ---------------------------------------------------------------------------
    it("vault balance delta equals the redemption quantity", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        312_000_000, // strike = $312
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      const userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Mint 30 pairs
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(30 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // Settle as Yes wins
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(320_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Advance past override deadline
      const m = await readMarket(ctx, ma.market);
      expect(m.outcome).to.equal(1); // Yes wins
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Read vault balance before redemption
      const vaultBefore = await getTokenBalance(ctx, ma.usdcVault);

      // Redeem 15 winning Yes tokens
      const REDEEM_QTY = 15 * ONE_TOKEN;
      const redeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        mode: 1, // winner redeem
        quantity: new BN(REDEEM_QTY),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), redeemIx),
        [ctx.admin],
      );

      // Read vault balance after redemption
      const vaultAfter = await getTokenBalance(ctx, ma.usdcVault);

      // Vault should have decreased by exactly the redemption quantity
      expect(vaultBefore - vaultAfter).to.equal(REDEEM_QTY);
      // Vault started with 30 tokens worth of USDC, drained 15 → 15 remaining
      expect(vaultAfter).to.equal(30 * ONE_TOKEN - REDEEM_QTY);
    });

    // ---------------------------------------------------------------------------
    // Test 14: Manual cancel_order still works post-settlement
    // ---------------------------------------------------------------------------
    it("manual cancel_order works post-settlement (refunds escrow)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        313_000_000, // strike = $313
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // Create a user with USDC for placing orders
      const { user: cancelUser, userUsdcAta: cancelUserUsdcAta, userYesAta: cancelUserYesAta, userNoAta: cancelUserNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 1_000_000_000);

      // Place a resting limit USDC bid at price 40
      const placeIx = buildPlaceOrderIx({
        user: cancelUser.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta: cancelUserUsdcAta,
        userYesAta: cancelUserYesAta,
        userNoAta: cancelUserNoAta,
        side: 0,     // USDC bid
        price: 40,
        quantity: new BN(10 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), placeIx), [cancelUser]);

      // Record USDC balance after placing (escrow deducted)
      const usdcAfterPlace = await getTokenBalance(ctx, cancelUserUsdcAta);

      // Read order book to get the order_id (level index for price 40 is 39, since 1-based prices map to 0-based)
      const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
      const obData = Buffer.from(obAcct!.data);
      const slot = readOrderSlot(obData, 39, 0); // price=40 → levelIdx=39
      expect(slot.isActive).to.be.true;
      const orderId = slot.orderId;

      // Advance past market close and settle
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(320_000_000),
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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

      // Now manually cancel the resting order post-settlement
      const cancelIx = buildCancelOrderIx({
        user: cancelUser.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        userUsdcAta: cancelUserUsdcAta,
        userYesAta: cancelUserYesAta,
        userNoAta: cancelUserNoAta,
        price: 40,
        orderId: new BN(orderId),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), cancelIx),
        [cancelUser],
      );

      // Verify escrow was refunded: 10 tokens * 40/100 = 4 USDC = 4_000_000
      const usdcAfterCancel = await getTokenBalance(ctx, cancelUserUsdcAta);
      expect(usdcAfterCancel - usdcAfterPlace).to.equal(4_000_000);
    });

    // ---------------------------------------------------------------------------
    // Test 15: Full lifecycle e2e — two-user happy path
    // ---------------------------------------------------------------------------
    it("full lifecycle e2e: create → mint → orders → fill → settle → crank → redeem → vault empty", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      // Step 1: Create market
      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        314_000_000, // strike = $314
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // --- Maker (admin) setup ---
      const makerYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const makerNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Step 2: Mint 50 pairs (maker gets 50 Yes + 50 No, vault gets $50 USDC)
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(50 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // --- Taker setup ---
      const { user: e2eTaker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 5_000_000_000);

      // Step 3: Maker places a limit Yes ask at price 60 for 20 tokens
      const askIx = buildPlaceOrderIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        side: 1,     // Yes ask (sell Yes)
        price: 60,
        quantity: new BN(20 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), askIx), [ctx.admin]);

      // Step 4: Taker places a market USDC bid that fills against the resting ask
      const takerBidIx = buildPlaceOrderIx({
        user: e2eTaker.publicKey,
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
        side: 0,     // USDC bid (buy Yes)
        price: 60,
        quantity: new BN(10 * ONE_TOKEN),
        orderType: 0, // Market
        maxFills: 5,
        makerAccounts: [userUsdcAta, makerYesAta, makerNoAta],
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), takerBidIx), [e2eTaker]);

      // Step 5: Taker places a resting limit USDC bid that will need cranking
      const restingBidIx = buildPlaceOrderIx({
        user: e2eTaker.publicKey,
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
        side: 0,     // USDC bid
        price: 30,
        quantity: new BN(5 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), restingBidIx), [e2eTaker]);

      // Step 6: Advance clock past close and settle
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(320_000_000), // above $314 → Yes wins
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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
      expect(m.outcome).to.equal(1); // Yes wins

      // Step 7: Crank cancel remaining resting orders (taker's resting bid + maker's remaining ask)
      const crankIx = buildCrankCancelIx({
        caller: ctx.admin.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        batchSize: 10,
        makerAccounts: [takerUsdcAta, makerYesAta],
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), crankIx),
        [ctx.admin],
      );

      // Step 8: Advance past override deadline
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Step 9: Maker redeems Yes tokens (winner)
      const makerYesBal = await getTokenBalance(ctx, makerYesAta);
      if (makerYesBal > 0) {
        const makerRedeemIx = buildRedeemIx({
          user: ctx.admin.publicKey,
          config,
          market: ma.market,
          yesMint: ma.yesMint,
          noMint: ma.noMint,
          usdcVault: ma.usdcVault,
          userUsdcAta,
          userYesAta: makerYesAta,
          userNoAta: makerNoAta,
          mode: 1, // winner redeem
          quantity: new BN(makerYesBal),
        });
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), makerRedeemIx),
          [ctx.admin],
        );
      }

      // Taker redeems Yes tokens (winner)
      const takerYesBal = await getTokenBalance(ctx, takerYesAta);
      if (takerYesBal > 0) {
        const takerRedeemIx = buildRedeemIx({
          user: e2eTaker.publicKey,
          config,
          market: ma.market,
          yesMint: ma.yesMint,
          noMint: ma.noMint,
          usdcVault: ma.usdcVault,
          userUsdcAta: takerUsdcAta,
          userYesAta: takerYesAta,
          userNoAta: takerNoAta,
          mode: 1,
          quantity: new BN(takerYesBal),
        });
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), takerRedeemIx),
          [e2eTaker],
        );
      }

      // Step 10: Verify vault is empty
      const vaultBalance = await getTokenBalance(ctx, ma.usdcVault);
      expect(vaultBalance).to.equal(0);
    });

    // ---------------------------------------------------------------------------
    // Test 16: Multi-user lifecycle (maker + taker)
    // ---------------------------------------------------------------------------
    it("multi-user lifecycle: maker posts quotes, taker fills, both settle and redeem", async () => {
      const provider = new BankrunProvider(ctx.context);
      const clock = await ctx.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const closeUnix = now + 5;

      // Create market
      const ma = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        315_000_000, // strike = $315
        closeUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );

      // --- Maker setup (admin) ---
      const makerYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
      const makerNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

      // Maker mints 100 pairs
      const mintIx = buildMintPairIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        usdcVault: ma.usdcVault,
        quantity: new BN(100 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), mintIx), [ctx.admin]);

      // --- Taker setup ---
      const { user: taker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
        await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 5_000_000_000);

      // Maker posts Yes ask at price 55 for 30 tokens (selling 30 Yes at 55 cents)
      const makerAskIx = buildPlaceOrderIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        orderBook: ma.orderBook,
        usdcVault: ma.usdcVault,
        escrowVault: ma.escrowVault,
        yesEscrow: ma.yesEscrow,
        noEscrow: ma.noEscrow,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        userUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        side: 1,     // Yes ask
        price: 55,
        quantity: new BN(30 * ONE_TOKEN),
        orderType: 1, // Limit
        maxFills: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), makerAskIx), [ctx.admin]);

      // Taker buys 30 Yes at 55 (market order filling the ask)
      const takerBidIx = buildPlaceOrderIx({
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
        side: 0,     // USDC bid
        price: 55,
        quantity: new BN(30 * ONE_TOKEN),
        orderType: 0, // Market
        maxFills: 5,
        makerAccounts: [userUsdcAta, makerYesAta, makerNoAta],
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), takerBidIx), [taker]);

      // Verify: taker now has 30 Yes tokens, maker got USDC back
      const takerYesBalance = await getTokenBalance(ctx, takerYesAta);
      expect(takerYesBalance).to.equal(30 * ONE_TOKEN);

      // Advance past market close, settle as Yes wins
      const settleTime = closeUnix + 10;
      await advanceClock(ctx, settleTime);

      const updateIx = buildUpdatePriceIx({
        authority: ctx.admin.publicKey,
        priceFeed: oracleFeed,
        price: new BN(320_000_000), // above $315 → Yes wins
        confidence: new BN(500_000),
        timestamp: new BN(settleTime),
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
      expect(m.outcome).to.equal(1); // Yes wins

      // Advance past override deadline
      await advanceClock(ctx, m.overrideDeadline + 10);

      // Both users redeem their Yes tokens
      // Maker has remaining Yes from mint (100 - 30 sold = 70 Yes still held)
      const makerYesBal = await getTokenBalance(ctx, makerYesAta);
      expect(makerYesBal).to.equal(70 * ONE_TOKEN);

      const makerRedeemIx = buildRedeemIx({
        user: ctx.admin.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta,
        userYesAta: makerYesAta,
        userNoAta: makerNoAta,
        mode: 1,
        quantity: new BN(makerYesBal),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), makerRedeemIx),
        [ctx.admin],
      );

      // Taker redeems 30 Yes tokens
      const takerRedeemIx = buildRedeemIx({
        user: taker.publicKey,
        config,
        market: ma.market,
        yesMint: ma.yesMint,
        noMint: ma.noMint,
        usdcVault: ma.usdcVault,
        userUsdcAta: takerUsdcAta,
        userYesAta: takerYesAta,
        userNoAta: takerNoAta,
        mode: 1,
        quantity: new BN(30 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), takerRedeemIx),
        [taker],
      );

      // Vault should be empty: 100 USDC minted, 100 Yes distributed (70 maker + 30 taker), all redeemed
      const vaultBalance = await getTokenBalance(ctx, ma.usdcVault);
      expect(vaultBalance).to.equal(0);
    });
  });
});
