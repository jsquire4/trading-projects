import { expect } from "chai";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
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
  MOCK_ORACLE_PROGRAM_ID,
  MERIDIAN_PROGRAM_ID,
  readOrderSlot,
  readLevelCount,
  SIDE_USDC_BID,
  SIDE_YES_ASK,
  SIDE_NO_BID,
  ORDER_TYPE_MARKET,
  ORDER_TYPE_LIMIT,
} from "../helpers";

import {
  buildPlaceOrderIx,
  buildMintPairIx,
  buildCancelOrderIx,
} from "../helpers/instructions";

import { getTokenBalance } from "../helpers/market-layout";
import { createFundedUserWithMarketAtas } from "../helpers/mint-helpers";


describe("Place Order", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts; // market accounts

  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000;
  const PREVIOUS_CLOSE = 195_000_000;
  let marketCloseUnix: number;
  const ONE_TOKEN = 1_000_000;
  const TEN_TOKENS = 10_000_000;

  // User accounts
  let userUsdcAta: PublicKey;
  let userYesAta: PublicKey;
  let userNoAta: PublicKey;

  before(async () => {
    ctx = await setupBankrun();

    // Use bankrun clock (not host clock) to set market close time
    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 198_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // Create USDC ATA and fund user
    userUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, ctx.admin.publicKey);
    await mintTestUsdc(ctx.context, usdcMint, ctx.admin, userUsdcAta, 1_000_000_000); // $1000

    // Derive Yes/No ATAs (will be created by mint_pair via init_if_needed)
    userYesAta = getAssociatedTokenAddressSync(ma.yesMint, ctx.admin.publicKey);
    userNoAta = getAssociatedTokenAddressSync(ma.noMint, ctx.admin.publicKey);

    // Mint 100 pairs so user has Yes + No tokens to trade
    const provider = new BankrunProvider(ctx.context);
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
      quantity: new BN(100 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(mintIx), [ctx.admin]);
  });

  function placeOrderIx(
    side: number, price: number, quantity: number,
    orderType: number, maxFills: number,
    makerAccounts?: PublicKey[],
    user?: Keypair,
  ) {
    const signer = user || ctx.admin;
    const uAta = user ? getAssociatedTokenAddressSync(usdcMint, signer.publicKey) : userUsdcAta;
    const yAta = user ? getAssociatedTokenAddressSync(ma.yesMint, signer.publicKey) : userYesAta;
    const nAta = user ? getAssociatedTokenAddressSync(ma.noMint, signer.publicKey) : userNoAta;

    return buildPlaceOrderIx({
      user: signer.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: uAta,
      userYesAta: yAta,
      userNoAta: nAta,
      side,
      price,
      quantity: new BN(quantity),
      orderType,
      maxFills,
      makerAccounts,
    });
  }

  it("places a USDC bid (Buy Yes) limit order on the book", async () => {
    // First we need to sell Yes tokens so user only holds No (satisfies position constraint)
    // Actually, user currently holds both Yes and No from minting.
    // position constraint: side=0 requires No balance == 0
    // So we need a user with no No tokens.
    // Let's use a fresh user that only has USDC.
    const { user: buyer, userUsdcAta: buyerUsdcAta, userYesAta: buyerYesAta, userNoAta: buyerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const provider = new BankrunProvider(ctx.context);

    const ix = buildPlaceOrderIx({
      user: buyer.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: buyerUsdcAta,
      userYesAta: buyerYesAta,
      userNoAta: buyerNoAta,
      side: SIDE_USDC_BID,
      price: 50,
      quantity: new BN(TEN_TOKENS),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 10,
    });

    await provider.sendAndConfirm!(new Transaction().add(ix), [buyer]);

    // Verify order is on the book at price level 49 (price 50 → index 49)
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, 49, 0);

    expect(slot.isActive).to.be.true;
    expect(slot.owner.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(slot.quantity).to.equal(TEN_TOKENS);
    expect(slot.side).to.equal(SIDE_USDC_BID);

    const count = readLevelCount(obData, 49);
    expect(count).to.equal(1);

    // Verify USDC was escrowed: 10 tokens * price 50 / 100 = 5 USDC = 5_000_000 lamports
    const escrowBal = await getTokenBalance(ctx, ma.escrowVault);
    expect(escrowBal).to.equal(5_000_000);
  });

  it("places a Yes ask (Sell Yes) limit order on the book", async () => {
    // Admin has Yes tokens from minting. Place a sell order.
    // But admin also has No tokens, which is fine for side=1 (no position constraint).
    const provider = new BankrunProvider(ctx.context);

    const ix = placeOrderIx(SIDE_YES_ASK, 60, TEN_TOKENS, ORDER_TYPE_LIMIT, 10);
    await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);

    // Verify on book at price level 59 (price 60 → index 59)
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, 59, 0);

    expect(slot.isActive).to.be.true;
    expect(slot.side).to.equal(SIDE_YES_ASK);
    expect(slot.quantity).to.equal(TEN_TOKENS);

    // Verify Yes tokens were escrowed
    const yesEscrowBal = await getTokenBalance(ctx, ma.yesEscrow);
    expect(yesEscrowBal).to.equal(TEN_TOKENS);
  });

  it("rejects price outside [1, 99]", async () => {
    const provider = new BankrunProvider(ctx.context);
    const ix = placeOrderIx(SIDE_YES_ASK, 0, TEN_TOKENS, ORDER_TYPE_LIMIT, 10);

    try {
      await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);
      expect.fail("Expected InvalidPrice error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x17a4|InvalidPrice|6052/i);
    }
  });

  it("rejects quantity below minimum (1 token)", async () => {
    const provider = new BankrunProvider(ctx.context);
    const ix = placeOrderIx(SIDE_YES_ASK, 50, 500_000, ORDER_TYPE_LIMIT, 10);

    try {
      await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);
      expect.fail("Expected InvalidQuantity error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x17a5|InvalidQuantity|6053/i);
    }
  });

  it("rejects Buy Yes when user holds No tokens (ConflictingPosition)", async () => {
    // Admin holds both Yes and No from minting → has No balance > 0
    // Trying to place a USDC bid (Buy Yes) should fail
    const provider = new BankrunProvider(ctx.context);
    const ix = placeOrderIx(SIDE_USDC_BID, 50, ONE_TOKEN, ORDER_TYPE_LIMIT, 10);

    try {
      await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);
      expect.fail("Expected ConflictingPosition error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x17ab|ConflictingPosition|6059/i);
    }
  });

  it("matches a USDC bid against a resting Yes ask (swap fill)", async () => {
    // Setup: fresh user places a USDC bid at price 60, which should match
    // the Yes ask at price 60 placed earlier by admin.
    const { user: taker, userUsdcAta: takerUsdcAta, userYesAta: takerYesAta, userNoAta: takerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const provider = new BankrunProvider(ctx.context);

    // Maker (admin) needs a USDC ATA to receive payment
    // Admin already has userUsdcAta
    const makerUsdcBefore = await getTokenBalance(ctx, userUsdcAta);

    const ix = buildPlaceOrderIx({
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
      side: SIDE_USDC_BID,
      price: 60,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [userUsdcAta], // admin's USDC ATA receives payment
    });

    await provider.sendAndConfirm!(new Transaction().add(ix), [taker]);

    // Taker should have received 5 Yes tokens
    const takerYesBal = await getTokenBalance(ctx, takerYesAta);
    expect(takerYesBal).to.equal(5 * ONE_TOKEN);

    // Maker (admin) should have received USDC: 5 tokens * 60/100 = 3 USDC = 3_000_000
    const makerUsdcAfter = await getTokenBalance(ctx, userUsdcAta);
    expect(makerUsdcAfter - makerUsdcBefore).to.equal(3_000_000);
  });

  it("cancels a resting USDC bid order and refunds escrow", async () => {
    // Place a USDC bid order with a fresh user, then cancel it
    const { user, userUsdcAta: uAta, userYesAta: yAta, userNoAta: nAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 50_000_000);
    const provider = new BankrunProvider(ctx.context);

    // Place limit bid at price 40
    const placeIx = buildPlaceOrderIx({
      user: user.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: uAta,
      userYesAta: yAta,
      userNoAta: nAta,
      side: SIDE_USDC_BID,
      price: 40,
      quantity: new BN(TEN_TOKENS),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });

    await provider.sendAndConfirm!(new Transaction().add(placeIx), [user]);

    // Read order book to get order ID
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, 39, 0); // price 40 → index 39
    expect(slot.isActive).to.be.true;

    const balBefore = await getTokenBalance(ctx, uAta);

    // Cancel
    const cancelIx = buildCancelOrderIx({
      user: user.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      userUsdcAta: uAta,
      userYesAta: yAta,
      userNoAta: nAta,
      price: 40,
      orderId: new BN(slot.orderId),
    });

    await provider.sendAndConfirm!(new Transaction().add(cancelIx), [user]);

    // Verify refund: 10 tokens * 40/100 = 4 USDC = 4_000_000
    const balAfter = await getTokenBalance(ctx, uAta);
    expect(balAfter - balBefore).to.equal(4_000_000);

    // Verify order deactivated
    const obAcct2 = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData2 = Buffer.from(obAcct2!.data);
    const slot2 = readOrderSlot(obData2, 39, 0);
    expect(slot2.isActive).to.be.false;
  });

  it("rejects cancel from non-owner", async () => {
    // Place an order as admin, try to cancel as different user
    const provider = new BankrunProvider(ctx.context);

    // Admin places a Yes ask
    const placeIx = placeOrderIx(SIDE_YES_ASK, 70, ONE_TOKEN, ORDER_TYPE_LIMIT, 0);
    await provider.sendAndConfirm!(new Transaction().add(placeIx), [ctx.admin]);

    // Read order ID
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    // Price 70 → index 69, find first active slot
    let orderId = 0;
    for (let i = 0; i < 16; i++) {
      const s = readOrderSlot(obData, 69, i);
      if (s.isActive && s.side === SIDE_YES_ASK) {
        orderId = s.orderId;
        break;
      }
    }

    // Different user tries to cancel
    const { user: attacker, userUsdcAta: aUsdcAta, userYesAta: aYesAta, userNoAta: aNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 0);

    const cancelIx = buildCancelOrderIx({
      user: attacker.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      userUsdcAta: aUsdcAta,
      userYesAta: aYesAta,
      userNoAta: aNoAta,
      price: 70,
      orderId: new BN(orderId),
    });

    try {
      await provider.sendAndConfirm!(new Transaction().add(cancelIx), [attacker]);
      expect.fail("Expected OrderNotOwned error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x17a7|OrderNotOwned|6055/i);
    }
  });

  it("places a No-backed bid (Sell No) limit order", async () => {
    // Admin holds both Yes and No tokens from mint_pair.
    // The ConflictingPosition constraint requires user_yes_ata.amount == 0
    // to place a No-backed bid. First sell all Yes tokens via a Yes Ask.
    const provider = new BankrunProvider(ctx.context);

    // Check remaining Yes balance and sell it all via Yes Ask (side=1)
    const yesBal = await getTokenBalance(ctx, userYesAta);
    if (yesBal > 0) {
      const sellYesIx = placeOrderIx(SIDE_YES_ASK, 99, yesBal, ORDER_TYPE_LIMIT, 0);
      await provider.sendAndConfirm!(new Transaction().add(sellYesIx), [ctx.admin]);
    }

    // Verify Yes balance is zero (escrowed in yesEscrow)
    const yesBalAfter = await getTokenBalance(ctx, userYesAta);
    expect(yesBalAfter).to.equal(0);

    const noBal = await getTokenBalance(ctx, userNoAta);
    expect(noBal).to.be.greaterThan(0);

    const ix = placeOrderIx(SIDE_NO_BID, 45, 5 * ONE_TOKEN, ORDER_TYPE_LIMIT, 10);
    await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);

    // Verify No tokens were escrowed
    const noEscrowBal = await getTokenBalance(ctx, ma.noEscrow);
    expect(noEscrowBal).to.equal(5 * ONE_TOKEN);
  });

  // ---------------------------------------------------------------------------
  // H13: Market order tests for Sell Yes (SIDE_YES_ASK)
  // ---------------------------------------------------------------------------
  it("matches a Sell Yes market order against a resting USDC bid (swap fill)", async () => {
    // Use fresh users — admin's Yes tokens were consumed by prior tests
    const { user: buyer, userUsdcAta: buyerUsdcAta, userYesAta: buyerYesAta, userNoAta: buyerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const provider = new BankrunProvider(ctx.context);

    // Buyer places resting USDC bid at price 75 (limit, no fills)
    // Use price 75 to avoid matching stale bids at 50 from earlier tests
    const bidIx = buildPlaceOrderIx({
      user: buyer.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: buyerUsdcAta,
      userYesAta: buyerYesAta,
      userNoAta: buyerNoAta,
      side: SIDE_USDC_BID,
      price: 75,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(bidIx), [buyer]);

    // Fund seller — mint pairs to get Yes tokens
    const { user: seller, userUsdcAta: sellerUsdcAta, userYesAta: sellerYesAta, userNoAta: sellerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    const mintIx = buildMintPairIx({
      user: seller.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerUsdcAta,
      userYesAta: sellerYesAta,
      userNoAta: sellerNoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(5 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(mintIx), [seller]);

    // Seller sells Yes via market order at price=75 (min acceptable bid)
    // This avoids sweeping stale bids at lower prices from earlier tests
    // Maker (buyer) receives Yes tokens, so we pass buyer's Yes ATA
    const sellerUsdcBefore = await getTokenBalance(ctx, sellerUsdcAta);
    const sellIx = buildPlaceOrderIx({
      user: seller.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerUsdcAta,
      userYesAta: sellerYesAta,
      userNoAta: sellerNoAta,
      side: SIDE_YES_ASK,
      price: 75,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [buyerYesAta],
    });
    await provider.sendAndConfirm!(new Transaction().add(sellIx), [seller]);

    // Seller should have received USDC: 3 tokens * 75/100 = 2.25 USDC = 2_250_000
    const sellerUsdcAfter = await getTokenBalance(ctx, sellerUsdcAta);
    expect(sellerUsdcAfter - sellerUsdcBefore).to.equal(2_250_000);

    // Buyer should have received 3 Yes tokens
    const buyerYesBal = await getTokenBalance(ctx, buyerYesAta);
    expect(buyerYesBal).to.equal(3 * ONE_TOKEN);
  });

  // ---------------------------------------------------------------------------
  // H13: Market order tests for Sell No (SIDE_NO_BID) — merge fill
  // ---------------------------------------------------------------------------
  it("matches a Sell No market order against a resting Yes ask (merge fill)", async () => {
    // Setup: fresh maker places a resting Yes ask, then a No holder sells into it
    const { user: maker, userUsdcAta: makerUsdcAta, userYesAta: makerYesAta, userNoAta: makerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const provider = new BankrunProvider(ctx.context);

    // Maker mints pairs and lists Yes ask at price 40
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
      quantity: new BN(10 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(mintIx), [maker]);

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
      side: SIDE_YES_ASK,
      price: 40,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(askIx), [maker]);

    // Fund seller — needs No tokens but NOT Yes tokens (ConflictingPosition constraint)
    const { user: seller, userUsdcAta: sellerUsdcAta, userYesAta: sellerYesAta, userNoAta: sellerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Seller mints pairs then sells all Yes tokens via limit (to clear ConflictingPosition)
    const sellerMintIx = buildMintPairIx({
      user: seller.publicKey,
      config,
      market: ma.market,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerUsdcAta,
      userYesAta: sellerYesAta,
      userNoAta: sellerNoAta,
      usdcVault: ma.usdcVault,
      quantity: new BN(5 * ONE_TOKEN),
    });
    await provider.sendAndConfirm!(new Transaction().add(sellerMintIx), [seller]);

    // Sell all Yes tokens first to clear the position constraint
    const clearYesIx = buildPlaceOrderIx({
      user: seller.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerUsdcAta,
      userYesAta: sellerYesAta,
      userNoAta: sellerNoAta,
      side: SIDE_YES_ASK,
      price: 99,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(clearYesIx), [seller]);

    // Verify seller has 0 Yes, 5 No
    const sellerYesBal = await getTokenBalance(ctx, sellerYesAta);
    expect(sellerYesBal).to.equal(0);
    const sellerNoBefore = await getTokenBalance(ctx, sellerNoAta);
    expect(sellerNoBefore).to.equal(5 * ONE_TOKEN);

    // Sell No market order — price=1, meaning max_yes_ask = 99 (sweep all asks)
    // This should match the maker's Yes ask at price 40 (merge fill)
    // Maker's USDC ATA receives the USDC payout from merge/burn
    const makerUsdcBefore = await getTokenBalance(ctx, makerUsdcAta);
    const sellerUsdcBefore = await getTokenBalance(ctx, sellerUsdcAta);
    const sellNoIx = buildPlaceOrderIx({
      user: seller.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerUsdcAta,
      userYesAta: sellerYesAta,
      userNoAta: sellerNoAta,
      side: SIDE_NO_BID,
      price: 1,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 10,
      makerAccounts: [makerUsdcAta], // maker receives USDC from merge
    });
    await provider.sendAndConfirm!(new Transaction().add(sellNoIx), [seller]);

    // Seller's No tokens should be consumed (burned in merge)
    // Maker had 5 tokens at ask price 40, seller sells 5 No at market (all fill)
    const sellerNoAfter = await getTokenBalance(ctx, sellerNoAta);
    expect(sellerNoAfter).to.equal(0);

    // Seller receives USDC: merge burn releases $1 per pair, seller gets (100-40)/100 = 60c per token
    // 5 tokens × 0.60 = $3.00 = 3_000_000 lamports
    const sellerUsdcAfter = await getTokenBalance(ctx, sellerUsdcAta);
    const expectedSellerPayout = Math.ceil((5 * ONE_TOKEN * (100 - 40)) / 100);
    expect(sellerUsdcAfter - sellerUsdcBefore).to.equal(expectedSellerPayout);

    // Maker receives their portion: 40c per token × 5 tokens = 2_000_000 lamports
    const makerUsdcAfter = await getTokenBalance(ctx, makerUsdcAta);
    const expectedMakerPayout = Math.floor((5 * ONE_TOKEN * 40) / 100);
    expect(makerUsdcAfter - makerUsdcBefore).to.equal(expectedMakerPayout);
  });
});
