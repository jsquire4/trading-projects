/**
 * market-closure.test.ts — Comprehensive bankrun test suite for market
 * closure lifecycle: close_market (standard close only).
 */

import { expect } from "chai";
import {
  PublicKey,
  Keypair,
  Transaction,
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
  findTreasury,
  findSolTreasury,
  findFeeVault,
  MOCK_ORACLE_PROGRAM_ID,
  mintTestUsdc,
  createAta,
} from "../helpers";

import {
  buildSettleMarketIx,
  buildRedeemIx,
  buildCrankCancelIx,
  buildMintPairIx,
  buildPlaceOrderIx,
  buildUpdatePriceIx,
  buildCloseMarketIx,
} from "../helpers/instructions";

import {
  readMarket,
  getTokenBalance,
  advanceClock,
  getMintSupply,
  tryCrankCancel,
} from "../helpers/market-layout";

import { createFundedUser, executeMintPair } from "../helpers/mint-helpers";
import { makeUniqueCuIxFactory } from "../helpers/tx-helpers";

const uniqueCuIx = makeUniqueCuIxFactory(500_000);

// Override window = 1s
const OVERRIDE_WINDOW_SECS = 1;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Market Closure", () => {
  let ctx: BankrunContext;
  let provider: BankrunProvider;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let treasury: PublicKey;
  let solTreasury: PublicKey;
  let oracleFeed: PublicKey;

  // "Clean" market — all tokens will be redeemed before close
  let maClean: MarketAccounts;
  let cleanCloseUnix: number;

  // "Dirty" market — tokens will remain after close (partial)
  let maDirty: MarketAccounts;
  let dirtyCloseUnix: number;

  // Users
  let adminUsdcAta: PublicKey;

  // Dirty market users: userA redeems, userB does NOT (tokens remain)
  let userA: Keypair;
  let userAUsdcAta: PublicKey;
  let userB: Keypair;
  let userBUsdcAta: PublicKey;

  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000; // $200
  const PREVIOUS_CLOSE = 195_000_000;
  const ONE_TOKEN = 1_000_000;

  before(async () => {
    ctx = await setupBankrun();
    provider = new BankrunProvider(ctx.context);

    const clock = await ctx.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);

    // Markets close quickly (in 5 seconds)
    cleanCloseUnix = now + 5;
    dirtyCloseUnix = now + 6; // different timestamp for unique PDA

    // Create USDC mint, config, oracle feed
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    [treasury] = findTreasury();
    [solTreasury] = findSolTreasury();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);

    // Set oracle price at $205 (above strike = Yes wins)
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 205_000_000, 500_000);

    // ── Create clean market ──
    maClean = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, cleanCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // ── Create dirty market (different strike for unique PDA) ──
    maDirty = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE + 1_000_000, dirtyCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // Admin USDC ATA
    adminUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, ctx.admin.publicKey);
    await mintTestUsdc(ctx.context, usdcMint, ctx.admin, adminUsdcAta, 100_000_000_000); // $100,000

    // ── Mint tokens on clean market: admin gets 100 pairs ──
    const adminYesClean = getAssociatedTokenAddressSync(maClean.yesMint, ctx.admin.publicKey);
    const adminNoClean = getAssociatedTokenAddressSync(maClean.noMint, ctx.admin.publicKey);
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildMintPairIx({
          user: ctx.admin.publicKey,
          config,
          market: maClean.market,
          yesMint: maClean.yesMint,
          noMint: maClean.noMint,
          userUsdcAta: adminUsdcAta,
          userYesAta: adminYesClean,
          userNoAta: adminNoClean,
          usdcVault: maClean.usdcVault,
          quantity: new BN(100 * ONE_TOKEN),
        }),
      ),
      [ctx.admin],
    );

    // ── Create funded users for dirty market ──
    ({ user: userA, userUsdcAta: userAUsdcAta } = await createFundedUser(
      ctx.context, ctx.admin, usdcMint, 10_000_000_000,
    ));
    ({ user: userB, userUsdcAta: userBUsdcAta } = await createFundedUser(
      ctx.context, ctx.admin, usdcMint, 10_000_000_000,
    ));

    // Mint 50 pairs for userA and 50 pairs for userB on dirty market
    await executeMintPair(ctx.context, userA, userAUsdcAta, config, maDirty, 50 * ONE_TOKEN);
    await executeMintPair(ctx.context, userB, userBUsdcAta, config, maDirty, 50 * ONE_TOKEN);

    // ── Advance past market close and settle both markets ──
    const settleTime = Math.max(cleanCloseUnix, dirtyCloseUnix) + 10;
    await advanceClock(ctx, settleTime);

    // Update oracle with fresh timestamp
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildUpdatePriceIx({
          authority: ctx.admin.publicKey,
          priceFeed: oracleFeed,
          price: new BN(205_000_000),
          confidence: new BN(500_000),
          timestamp: new BN(settleTime),
        }),
      ),
      [ctx.admin],
    );

    // Settle clean market (Yes wins, outcome=1)
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildSettleMarketIx({
          caller: ctx.admin.publicKey,
          config,
          market: maClean.market,
          oracleFeed,
        }),
      ),
      [ctx.admin],
    );

    // Settle dirty market
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildSettleMarketIx({
          caller: ctx.admin.publicKey,
          config,
          market: maDirty.market,
          oracleFeed,
        }),
      ),
      [ctx.admin],
    );

    // Advance past override window
    const pastOverride = settleTime + OVERRIDE_WINDOW_SECS + 10;
    await advanceClock(ctx, pastOverride);

    // Crank cancel both markets (order books should be empty — ignore CrankNotNeeded)
    await tryCrankCancel(provider, {
      caller: ctx.admin.publicKey, config,
      market: maClean.market, orderBook: maClean.orderBook,
      escrowVault: maClean.escrowVault, yesEscrow: maClean.yesEscrow, noEscrow: maClean.noEscrow,
    }, [ctx.admin], uniqueCuIx);

    await tryCrankCancel(provider, {
      caller: ctx.admin.publicKey, config,
      market: maDirty.market, orderBook: maDirty.orderBook,
      escrowVault: maDirty.escrowVault, yesEscrow: maDirty.yesEscrow, noEscrow: maDirty.noEscrow,
    }, [ctx.admin], uniqueCuIx);

    // ── Redeem ALL tokens on clean market (pair burn) ──
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildRedeemIx({
          user: ctx.admin.publicKey,
          config,
          market: maClean.market,
          yesMint: maClean.yesMint,
          noMint: maClean.noMint,
          usdcVault: maClean.usdcVault,
          userUsdcAta: adminUsdcAta,
          userYesAta: adminYesClean,
          userNoAta: adminNoClean,
          mode: 0, // pair burn
          quantity: new BN(100 * ONE_TOKEN),
        }),
      ),
      [ctx.admin],
    );

    // ── Redeem userA tokens on dirty market (winner redeem — Yes wins) ──
    const userAYesAta = getAssociatedTokenAddressSync(maDirty.yesMint, userA.publicKey);
    const userANoAta = getAssociatedTokenAddressSync(maDirty.noMint, userA.publicKey);
    // Redeem userA's 50 Yes tokens (winners)
    await provider.sendAndConfirm!(
      new Transaction().add(
        uniqueCuIx(),
        buildRedeemIx({
          user: userA.publicKey,
          config,
          market: maDirty.market,
          yesMint: maDirty.yesMint,
          noMint: maDirty.noMint,
          usdcVault: maDirty.usdcVault,
          userUsdcAta: userAUsdcAta,
          userYesAta: userAYesAta,
          userNoAta: userANoAta,
          mode: 1, // winner redeem
          quantity: new BN(50 * ONE_TOKEN),
        }),
      ),
      [userA],
    );

    // UserB does NOT redeem — 50 Yes + 50 No tokens remain outstanding
  });

  // =========================================================================
  // close_market error cases
  // =========================================================================
  describe("close_market errors", () => {
    it("rejects unsettled market (0x17de = 6110)", async () => {
      // Create a third, unsettled market (use future close time relative to current clock)
      const clock = await ctx.context.banksClient.getClock();
      const nowTs = Number(clock.unixTimestamp);
      const unsettledCloseUnix = nowTs + 86400; // 1 day in the future
      const maUnsettled = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        STRIKE_PRICE + 2_000_000, unsettledCloseUnix, PREVIOUS_CLOSE,
        oracleFeed, usdcMint,
      );

      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: maUnsettled.market,
        orderBook: maUnsettled.orderBook,
        usdcVault: maUnsettled.usdcVault,
        escrowVault: maUnsettled.escrowVault,
        yesEscrow: maUnsettled.yesEscrow,
        noEscrow: maUnsettled.noEscrow,
        yesMint: maUnsettled.yesMint,
        noMint: maUnsettled.noMint,
        treasury,
        solTreasury,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("0x17de");
      }
    });

    it("rejects when override window is still active (0x17df = 6111)", async () => {
      // Create, settle, but DON'T advance past override window
      const clock = await ctx.context.banksClient.getClock();
      const nowTs = Number(clock.unixTimestamp);
      const overrideCloseUnix = nowTs + 5;
      const maOverride = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        STRIKE_PRICE + 3_000_000, overrideCloseUnix, PREVIOUS_CLOSE,
        oracleFeed, usdcMint,
      );

      // Advance past market close and settle
      const settleTs = overrideCloseUnix + 10;
      await advanceClock(ctx, settleTs);

      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildUpdatePriceIx({
            authority: ctx.admin.publicKey,
            priceFeed: oracleFeed,
            price: new BN(205_000_000),
            confidence: new BN(500_000),
            timestamp: new BN(settleTs),
          }),
        ),
        [ctx.admin],
      );

      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildSettleMarketIx({
            caller: ctx.admin.publicKey,
            config,
            market: maOverride.market,
            oracleFeed,
          }),
        ),
        [ctx.admin],
      );

      // Try closing immediately (override window still active)
      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: maOverride.market,
        orderBook: maOverride.orderBook,
        usdcVault: maOverride.usdcVault,
        escrowVault: maOverride.escrowVault,
        yesEscrow: maOverride.yesEscrow,
        noEscrow: maOverride.noEscrow,
        yesMint: maOverride.yesMint,
        noMint: maOverride.noMint,
        treasury,
        solTreasury,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("0x17df");
      }
    });

    it("rejects when order book is not empty (0x17e0 = 6112)", async () => {
      // Create market, place an order, settle, advance past override, but don't crank
      const clock1 = await ctx.context.banksClient.getClock();
      const currentTs = Number(clock1.unixTimestamp);
      const obCloseUnix = currentTs + 100;
      const maOb = await createTestMarket(
        ctx.context, ctx.admin, config, TICKER,
        STRIKE_PRICE + 4_000_000, obCloseUnix, PREVIOUS_CLOSE,
        oracleFeed, usdcMint,
      );

      // Mint pairs first so user has tokens
      const adminYesOb = getAssociatedTokenAddressSync(maOb.yesMint, ctx.admin.publicKey);
      const adminNoOb = getAssociatedTokenAddressSync(maOb.noMint, ctx.admin.publicKey);
      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildMintPairIx({
            user: ctx.admin.publicKey,
            config,
            market: maOb.market,
            yesMint: maOb.yesMint,
            noMint: maOb.noMint,
            userUsdcAta: adminUsdcAta,
            userYesAta: adminYesOb,
            userNoAta: adminNoOb,
            usdcVault: maOb.usdcVault,
            quantity: new BN(10 * ONE_TOKEN),
          }),
        ),
        [ctx.admin],
      );

      // Place a limit order
      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildPlaceOrderIx({
            user: ctx.admin.publicKey,
            config,
            market: maOb.market,
            orderBook: maOb.orderBook,
            usdcVault: maOb.usdcVault,
            escrowVault: maOb.escrowVault,
            yesEscrow: maOb.yesEscrow,
            noEscrow: maOb.noEscrow,
            yesMint: maOb.yesMint,
            noMint: maOb.noMint,
            userUsdcAta: adminUsdcAta,
            userYesAta: adminYesOb,
            userNoAta: adminNoOb,
            feeVault,
            side: 1, // Yes ask (Sell Yes) — avoids ConflictingPosition
            price: 50,
            quantity: new BN(5 * ONE_TOKEN),
            orderType: 1, // Limit
            maxFills: 0,
          }),
        ),
        [ctx.admin],
      );

      // Settle the market
      const settleTs2 = Math.max(obCloseUnix + 10, currentTs + 1);
      await advanceClock(ctx, settleTs2);

      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildUpdatePriceIx({
            authority: ctx.admin.publicKey,
            priceFeed: oracleFeed,
            price: new BN(205_000_000),
            confidence: new BN(500_000),
            timestamp: new BN(settleTs2),
          }),
        ),
        [ctx.admin],
      );

      await provider.sendAndConfirm!(
        new Transaction().add(
          uniqueCuIx(),
          buildSettleMarketIx({
            caller: ctx.admin.publicKey,
            config,
            market: maOb.market,
            oracleFeed,
          }),
        ),
        [ctx.admin],
      );

      // Advance past override window but DON'T crank cancel
      const pastOverride2 = settleTs2 + OVERRIDE_WINDOW_SECS + 10;
      await advanceClock(ctx, pastOverride2);

      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: maOb.market,
        orderBook: maOb.orderBook,
        usdcVault: maOb.usdcVault,
        escrowVault: maOb.escrowVault,
        yesEscrow: maOb.yesEscrow,
        noEscrow: maOb.noEscrow,
        yesMint: maOb.yesMint,
        noMint: maOb.noMint,
        treasury,
        solTreasury,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("0x17e0");
      }
    });

    it("rejects when tokens still outstanding (MintSupplyNotZero 0x17e5 = 6117)", async () => {
      // Dirty market has outstanding tokens — standard close requires supply == 0
      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: maDirty.market,
        orderBook: maDirty.orderBook,
        usdcVault: maDirty.usdcVault,
        escrowVault: maDirty.escrowVault,
        yesEscrow: maDirty.yesEscrow,
        noEscrow: maDirty.noEscrow,
        yesMint: maDirty.yesMint,
        noMint: maDirty.noMint,
        treasury,
        solTreasury,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [ctx.admin],
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("0x17e5");
      }
    });

    it("rejects non-admin caller (0x1770 = 6000)", async () => {
      const ix = buildCloseMarketIx({
        admin: userA.publicKey, // not admin
        config,
        market: maClean.market,
        orderBook: maClean.orderBook,
        usdcVault: maClean.usdcVault,
        escrowVault: maClean.escrowVault,
        yesEscrow: maClean.yesEscrow,
        noEscrow: maClean.noEscrow,
        yesMint: maClean.yesMint,
        noMint: maClean.noMint,
        treasury,
        solTreasury,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), ix),
          [userA],
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        // Anchor has_one = admin constraint → Unauthorized or constraint violation
        expect(err.toString()).to.match(/0x1770|0x7d[36]|ConstraintHasOne|Unauthorized/);
      }
    });
  });

  // =========================================================================
  // close_market: standard close (all tokens redeemed)
  //
  // Closes 6 accounts (market, orderbook, 4 token vaults).
  // Mints remain (owned by Token program, can't be closed via SPL Token v1).
  // =========================================================================
  describe("close_market standard close", () => {
    it("succeeds when all tokens redeemed", async () => {
      // Verify supplies are 0 (all redeemed)
      const yesSupply = await getMintSupply(ctx, maClean.yesMint);
      const noSupply = await getMintSupply(ctx, maClean.noMint);
      expect(yesSupply).to.equal(0n);
      expect(noSupply).to.equal(0n);

      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: maClean.market,
        orderBook: maClean.orderBook,
        usdcVault: maClean.usdcVault,
        escrowVault: maClean.escrowVault,
        yesEscrow: maClean.yesEscrow,
        noEscrow: maClean.noEscrow,
        yesMint: maClean.yesMint,
        noMint: maClean.noMint,
        treasury,
        solTreasury,
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), ix),
        [ctx.admin],
      );
    });

    it("closes market, orderbook, and 4 vaults (mints remain)", async () => {
      // Market and orderbook should be drained/closed
      const marketAcct = await ctx.context.banksClient.getAccount(maClean.market);
      const orderBookAcct = await ctx.context.banksClient.getAccount(maClean.orderBook);
      const vaultAcct = await ctx.context.banksClient.getAccount(maClean.usdcVault);
      const escrowAcct = await ctx.context.banksClient.getAccount(maClean.escrowVault);
      const yesEscrowAcct = await ctx.context.banksClient.getAccount(maClean.yesEscrow);
      const noEscrowAcct = await ctx.context.banksClient.getAccount(maClean.noEscrow);

      // These 6 should be closed (null or zero lamports)
      expect(marketAcct == null || BigInt(marketAcct.lamports) === 0n, "market should be closed").to.be.true;
      expect(orderBookAcct == null || BigInt(orderBookAcct.lamports) === 0n, "orderbook should be closed").to.be.true;
      expect(vaultAcct == null || BigInt(vaultAcct.lamports) === 0n, "usdc vault should be closed").to.be.true;
      expect(escrowAcct == null || BigInt(escrowAcct.lamports) === 0n, "escrow should be closed").to.be.true;
      expect(yesEscrowAcct == null || BigInt(yesEscrowAcct.lamports) === 0n, "yes escrow should be closed").to.be.true;
      expect(noEscrowAcct == null || BigInt(noEscrowAcct.lamports) === 0n, "no escrow should be closed").to.be.true;

      // Mints should still exist (owned by Token program)
      const yesMintAcct = await ctx.context.banksClient.getAccount(maClean.yesMint);
      const noMintAcct = await ctx.context.banksClient.getAccount(maClean.noMint);
      expect(yesMintAcct != null, "yes mint should still exist").to.be.true;
      expect(noMintAcct != null, "no mint should still exist").to.be.true;
    });
  });

  // treasury_redeem, cleanup_market, and partial close tests removed —
  // these features are deprecated. Standard close is the only path.
});
