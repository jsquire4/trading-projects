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
  findFeeVault,
  MOCK_ORACLE_PROGRAM_ID,
  MERIDIAN_PROGRAM_ID,
  readOrderSlot,
  readLevelCount,
  priceLevelIdx,
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
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts; // market accounts
  let provider: BankrunProvider;

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
    [feeVault] = findFeeVault();
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
    provider = new BankrunProvider(ctx.context);
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
      feeVault,
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


    const ix = placeOrderIx(SIDE_USDC_BID, 50, TEN_TOKENS, ORDER_TYPE_LIMIT, 10, undefined, buyer);

    await provider.sendAndConfirm!(new Transaction().add(ix), [buyer]);

    // Verify order is on the book at the sparse level for price 50
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, priceLevelIdx(obData, 50), 0);

    expect(slot.isActive).to.be.true;
    expect(slot.owner.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(slot.quantity).to.equal(TEN_TOKENS);
    expect(slot.side).to.equal(SIDE_USDC_BID);

    const count = readLevelCount(obData, priceLevelIdx(obData, 50));
    expect(count).to.equal(1);

    // Verify USDC was escrowed: 10 tokens * price 50 / 100 = 5 USDC = 5_000_000 lamports
    const escrowBal = await getTokenBalance(ctx, ma.escrowVault);
    expect(escrowBal).to.equal(5_000_000);
  });

  it("places a Yes ask (Sell Yes) limit order on the book", async () => {
    // Admin has Yes tokens from minting. Place a sell order.
    // But admin also has No tokens, which is fine for side=1 (no position constraint).


    const ix = placeOrderIx(SIDE_YES_ASK, 60, TEN_TOKENS, ORDER_TYPE_LIMIT, 10);
    await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);

    // Verify on book at the sparse level for price 60
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, priceLevelIdx(obData, 60), 0);

    expect(slot.isActive).to.be.true;
    expect(slot.side).to.equal(SIDE_YES_ASK);
    expect(slot.quantity).to.equal(TEN_TOKENS);

    // Verify Yes tokens were escrowed
    const yesEscrowBal = await getTokenBalance(ctx, ma.yesEscrow);
    expect(yesEscrowBal).to.equal(TEN_TOKENS);
  });

  it("rejects price outside [1, 99]", async () => {

    const ix = placeOrderIx(SIDE_YES_ASK, 0, TEN_TOKENS, ORDER_TYPE_LIMIT, 10);

    try {
      await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);
      expect.fail("Expected InvalidPrice error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x17a4|InvalidPrice|6052/i);
    }
  });

  it("rejects quantity below minimum (1 token)", async () => {

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


    // Maker (admin) needs a USDC ATA to receive payment
    // Admin already has userUsdcAta
    const makerUsdcBefore = await getTokenBalance(ctx, userUsdcAta);

    const ix = placeOrderIx(SIDE_USDC_BID, 60, 5 * ONE_TOKEN, ORDER_TYPE_MARKET, 10, [userUsdcAta], taker);

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


    // Place limit bid at price 40
    const placeIx = placeOrderIx(SIDE_USDC_BID, 40, TEN_TOKENS, ORDER_TYPE_LIMIT, 0, undefined, user);

    await provider.sendAndConfirm!(new Transaction().add(placeIx), [user]);

    // Read order book to get order ID
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slot = readOrderSlot(obData, priceLevelIdx(obData, 40), 0);
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

    // Verify order deactivated — in sparse layout, the level is freed
    // when the last order is cancelled, so price_map should show unallocated.
    const obAcct2 = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData2 = Buffer.from(obAcct2!.data);
    const levelAfter = priceLevelIdx(obData2, 40);
    // Level should be freed (unallocated) since it was the only order
    expect(levelAfter).to.equal(0xFFFF);
  });

  it("rejects cancel from non-owner", async () => {
    // Place an order as admin, try to cancel as different user


    // Admin places a Yes ask
    const placeIx = placeOrderIx(SIDE_YES_ASK, 70, ONE_TOKEN, ORDER_TYPE_LIMIT, 0);
    await provider.sendAndConfirm!(new Transaction().add(placeIx), [ctx.admin]);

    // Read order ID
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    // Find first active slot at price 70
    let orderId = 0;
    for (let i = 0; i < 16; i++) {
      const s = readOrderSlot(obData, priceLevelIdx(obData, 70), i);
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


    // Buyer places resting USDC bid at price 75 (limit, no fills)
    // Use price 75 to avoid matching stale bids at 50 from earlier tests
    const bidIx = placeOrderIx(SIDE_USDC_BID, 75, 3 * ONE_TOKEN, ORDER_TYPE_LIMIT, 0, undefined, buyer);
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
    const sellIx = placeOrderIx(SIDE_YES_ASK, 75, 3 * ONE_TOKEN, ORDER_TYPE_MARKET, 10, [buyerYesAta], seller);
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

    const askIx = placeOrderIx(SIDE_YES_ASK, 40, 5 * ONE_TOKEN, ORDER_TYPE_LIMIT, 0, undefined, maker);
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
    const clearYesIx = placeOrderIx(SIDE_YES_ASK, 99, 5 * ONE_TOKEN, ORDER_TYPE_LIMIT, 0, undefined, seller);
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
    const sellNoIx = placeOrderIx(SIDE_NO_BID, 1, 5 * ONE_TOKEN, ORDER_TYPE_MARKET, 10, [makerUsdcAta], seller);
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

// ===========================================================================
// FIFO Priority Tests — timestamp-based matching within price levels
// ===========================================================================
describe("FIFO Priority (timestamp-based matching)", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;
  let provider: BankrunProvider;

  const TICKER = "MSFT";
  const STRIKE_PRICE = 400_000_000;
  const PREVIOUS_CLOSE = 390_000_000;
  let marketCloseUnix: number;
  const ONE_TOKEN = 1_000_000;

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 395_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    provider = new BankrunProvider(ctx.context);
  });

  it("fills older order first when two asks exist at the same price", async () => {

    // Create two sellers with Yes tokens
    const { user: sellerA, userUsdcAta: sellerAUsdcAta, userYesAta: sellerAYesAta, userNoAta: sellerANoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);
    const { user: sellerB, userUsdcAta: sellerBUsdcAta, userYesAta: sellerBYesAta, userNoAta: sellerBNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Mint pairs for both sellers to get Yes tokens
    for (const [user, uAta, yAta, nAta] of [
      [sellerA, sellerAUsdcAta, sellerAYesAta, sellerANoAta],
      [sellerB, sellerBUsdcAta, sellerBYesAta, sellerBNoAta],
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
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(mintIx), [user]);
    }

    // Set clock to t=1000 and place order A (ask at price 50)
    const clock = await ctx.context.banksClient.getClock();
    const { Clock } = await import("solana-bankrun");
    ctx.context.setClock(new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(1000),
    ));

    const askAIx = buildPlaceOrderIx({
      user: sellerA.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerAUsdcAta,
      userYesAta: sellerAYesAta,
      userNoAta: sellerANoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 50,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(askAIx), [sellerA]);

    // Set clock to t=2000 and place order B (ask at same price 50)
    ctx.context.setClock(new Clock(
      clock.slot + 1n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(2000),
    ));

    const askBIx = buildPlaceOrderIx({
      user: sellerB.publicKey,
      config,
      market: ma.market,
      orderBook: ma.orderBook,
      usdcVault: ma.usdcVault,
      escrowVault: ma.escrowVault,
      yesEscrow: ma.yesEscrow,
      noEscrow: ma.noEscrow,
      yesMint: ma.yesMint,
      noMint: ma.noMint,
      userUsdcAta: sellerBUsdcAta,
      userYesAta: sellerBYesAta,
      userNoAta: sellerBNoAta,
      feeVault,
      side: SIDE_YES_ASK,
      price: 50,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(askBIx), [sellerB]);

    // Verify both orders are on the book
    const obAcct = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData = Buffer.from(obAcct!.data);
    const slotA = readOrderSlot(obData, priceLevelIdx(obData, 50), 0);
    const slotB = readOrderSlot(obData, priceLevelIdx(obData, 50), 1);
    expect(slotA.isActive).to.be.true;
    expect(slotB.isActive).to.be.true;
    expect(slotA.owner.toBase58()).to.equal(sellerA.publicKey.toBase58());
    expect(slotB.owner.toBase58()).to.equal(sellerB.publicKey.toBase58());
    expect(slotA.timestamp).to.equal(1000);
    expect(slotB.timestamp).to.equal(2000);

    // Create a buyer that buys only 5 tokens (fills exactly one order)
    const { user: buyer, userUsdcAta: buyerUsdcAta, userYesAta: buyerYesAta, userNoAta: buyerNoAta } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma, 100_000_000);

    // Set clock forward to avoid "already processed" issues
    ctx.context.setClock(new Clock(
      clock.slot + 2n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(3000),
    ));

    // Buyer places USDC bid at price 50, quantity 5 tokens — should fill against older order A
    // Only pass sellerA's USDC ATA since FIFO fills sellerA first (exactly 5 tokens = 1 fill)
    const buyIx = buildPlaceOrderIx({
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
      feeVault,
      side: SIDE_USDC_BID,
      price: 50,
      quantity: new BN(5 * ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 1,
      makerAccounts: [sellerAUsdcAta],
    });
    await provider.sendAndConfirm!(new Transaction().add(buyIx), [buyer]);

    // Verify: order A (the older one at t=1000) should be filled (inactive)
    // and order B (newer at t=2000) should remain active
    const obAcct2 = await ctx.context.banksClient.getAccount(ma.orderBook);
    const obData2 = Buffer.from(obAcct2!.data);

    const slotA2 = readOrderSlot(obData2, priceLevelIdx(obData2, 50), 0);
    const slotB2 = readOrderSlot(obData2, priceLevelIdx(obData2, 50), 1);

    expect(slotA2.isActive).to.be.false;  // Older order filled first
    expect(slotB2.isActive).to.be.true;   // Newer order still resting
    expect(slotB2.quantity).to.equal(5 * ONE_TOKEN); // Untouched

    // Verify USDC proceeds went to sellerA (the filled maker), not sellerB
    const sellerAUsdcAfter = await getTokenBalance(ctx, sellerAUsdcAta);
    const sellerBUsdcAfter = await getTokenBalance(ctx, sellerBUsdcAta);
    // sellerA started with 100M, spent 10M on mint, gets USDC from fill
    // sellerB started with 100M, spent 10M on mint, should NOT have received fill proceeds
    expect(sellerAUsdcAfter).to.be.greaterThan(90_000_000); // got fill proceeds
    expect(sellerBUsdcAfter).to.equal(90_000_000); // no fill, just mint cost
  });

  it("fills original older order before a newer order placed in a cancelled slot", async () => {


    // Create a SEPARATE market to avoid interference from the first FIFO test's
    // leftover orders. The USDC BID sweep walks all ask levels from 1 to bid price,
    // so leftover asks at price 50 from test 1 would match first.
    const clock0 = await ctx.context.banksClient.getClock();
    const m2CloseUnix = Number(clock0.unixTimestamp) + 86400;

    const ma2 = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      410_000_000, // different strike → unique PDA
      m2CloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    // Create three sellers
    const { user: s1, userUsdcAta: s1Usdc, userYesAta: s1Yes, userNoAta: s1No } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma2, 100_000_000);
    const { user: s2, userUsdcAta: s2Usdc, userYesAta: s2Yes, userNoAta: s2No } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma2, 100_000_000);
    const { user: s3, userUsdcAta: s3Usdc, userYesAta: s3Yes, userNoAta: s3No } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma2, 100_000_000);

    // Mint pairs for all three sellers
    for (const [user, uAta, yAta, nAta] of [
      [s1, s1Usdc, s1Yes, s1No],
      [s2, s2Usdc, s2Yes, s2No],
      [s3, s3Usdc, s3Yes, s3No],
    ] as [Keypair, PublicKey, PublicKey, PublicKey][]) {
      const mintIx = buildMintPairIx({
        user: user.publicKey,
        config,
        market: ma2.market,
        yesMint: ma2.yesMint,
        noMint: ma2.noMint,
        userUsdcAta: uAta,
        userYesAta: yAta,
        userNoAta: nAta,
        usdcVault: ma2.usdcVault,
        quantity: new BN(10 * ONE_TOKEN),
      });
      await provider.sendAndConfirm!(new Transaction().add(mintIx), [user]);
    }

    const { Clock } = await import("solana-bankrun");
    const clock = await ctx.context.banksClient.getClock();

    const PRICE = 60;

    // Place order 1 at t=4000
    ctx.context.setClock(new Clock(
      clock.slot + 10n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(4000),
    ));

    const ask1Ix = buildPlaceOrderIx({
      user: s1.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      usdcVault: ma2.usdcVault,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      yesMint: ma2.yesMint,
      noMint: ma2.noMint,
      userUsdcAta: s1Usdc,
      userYesAta: s1Yes,
      userNoAta: s1No,
      feeVault,
      side: SIDE_YES_ASK,
      price: PRICE,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(ask1Ix), [s1]);

    // Place order 2 at t=5000
    ctx.context.setClock(new Clock(
      clock.slot + 11n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(5000),
    ));

    const ask2Ix = buildPlaceOrderIx({
      user: s2.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      usdcVault: ma2.usdcVault,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      yesMint: ma2.yesMint,
      noMint: ma2.noMint,
      userUsdcAta: s2Usdc,
      userYesAta: s2Yes,
      userNoAta: s2No,
      feeVault,
      side: SIDE_YES_ASK,
      price: PRICE,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(ask2Ix), [s2]);

    // Place order 3 at t=6000
    ctx.context.setClock(new Clock(
      clock.slot + 12n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(6000),
    ));

    const ask3Ix = buildPlaceOrderIx({
      user: s3.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      usdcVault: ma2.usdcVault,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      yesMint: ma2.yesMint,
      noMint: ma2.noMint,
      userUsdcAta: s3Usdc,
      userYesAta: s3Yes,
      userNoAta: s3No,
      feeVault,
      side: SIDE_YES_ASK,
      price: PRICE,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(ask3Ix), [s3]);

    // Verify all three orders placed: slots 0, 1, 2
    let obAcct = await ctx.context.banksClient.getAccount(ma2.orderBook);
    let obData = Buffer.from(obAcct!.data);
    expect(readOrderSlot(obData, priceLevelIdx(obData, PRICE), 0).isActive).to.be.true;
    expect(readOrderSlot(obData, priceLevelIdx(obData, PRICE), 1).isActive).to.be.true;
    expect(readOrderSlot(obData, priceLevelIdx(obData, PRICE), 2).isActive).to.be.true;

    // Read order 2's orderId for cancellation
    const order2Id = readOrderSlot(obData, priceLevelIdx(obData, PRICE), 1).orderId;

    // Cancel order 2 (the middle one at t=5000), creating a slot gap
    ctx.context.setClock(new Clock(
      clock.slot + 13n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(6500),
    ));

    const cancelIx = buildCancelOrderIx({
      user: s2.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      userUsdcAta: s2Usdc,
      userYesAta: s2Yes,
      userNoAta: s2No,
      price: PRICE,
      orderId: new BN(order2Id),
    });
    await provider.sendAndConfirm!(new Transaction().add(cancelIx), [s2]);

    // Verify slot 1 is now inactive (cancelled)
    obAcct = await ctx.context.banksClient.getAccount(ma2.orderBook);
    obData = Buffer.from(obAcct!.data);
    expect(readOrderSlot(obData, priceLevelIdx(obData, PRICE), 1).isActive).to.be.false;

    // Place a new order from s2 at t=7000 — should take the cancelled slot (slot 1)
    ctx.context.setClock(new Clock(
      clock.slot + 14n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(7000),
    ));

    const ask4Ix = buildPlaceOrderIx({
      user: s2.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      usdcVault: ma2.usdcVault,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      yesMint: ma2.yesMint,
      noMint: ma2.noMint,
      userUsdcAta: s2Usdc,
      userYesAta: s2Yes,
      userNoAta: s2No,
      feeVault,
      side: SIDE_YES_ASK,
      price: PRICE,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_LIMIT,
      maxFills: 0,
    });
    await provider.sendAndConfirm!(new Transaction().add(ask4Ix), [s2]);

    // Verify the new order is active and has timestamp 7000
    obAcct = await ctx.context.banksClient.getAccount(ma2.orderBook);
    obData = Buffer.from(obAcct!.data);

    // Find which slot the new order took (should be slot 1, the cancelled gap)
    let newSlotIdx = -1;
    const loff = priceLevelIdx(obData, PRICE);
    const opl = obData[loff + 2]; // per-level slot_count
    for (let i = 0; i < opl; i++) {
      const s = readOrderSlot(obData, priceLevelIdx(obData, PRICE), i);
      if (s.isActive && s.owner.toBase58() === s2.publicKey.toBase58()) {
        newSlotIdx = i;
        break;
      }
    }
    expect(newSlotIdx).to.be.greaterThanOrEqual(0);
    const newSlot = readOrderSlot(obData, priceLevelIdx(obData, PRICE), newSlotIdx);
    expect(newSlot.timestamp).to.equal(7000);

    // Now create a buyer and fill exactly one order
    // FIFO picks s1 (t=4000) first, so s1Usdc must be the first remaining account
    const { user: buyer, userUsdcAta: buyerUsdc, userYesAta: buyerYes, userNoAta: buyerNo } =
      await createFundedUserWithMarketAtas(ctx.context, ctx.admin, usdcMint, ma2, 100_000_000);

    ctx.context.setClock(new Clock(
      clock.slot + 15n,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(8000),
    ));

    const buyIx = buildPlaceOrderIx({
      user: buyer.publicKey,
      config,
      market: ma2.market,
      orderBook: ma2.orderBook,
      usdcVault: ma2.usdcVault,
      escrowVault: ma2.escrowVault,
      yesEscrow: ma2.yesEscrow,
      noEscrow: ma2.noEscrow,
      yesMint: ma2.yesMint,
      noMint: ma2.noMint,
      userUsdcAta: buyerUsdc,
      userYesAta: buyerYes,
      userNoAta: buyerNo,
      feeVault,
      side: SIDE_USDC_BID,
      price: PRICE,
      quantity: new BN(3 * ONE_TOKEN),
      orderType: ORDER_TYPE_MARKET,
      maxFills: 1, // only fill one order
      makerAccounts: [s1Usdc],
    });
    await provider.sendAndConfirm!(new Transaction().add(buyIx), [buyer]);

    // Verify: order 1 (t=4000, the oldest) should be filled
    obAcct = await ctx.context.banksClient.getAccount(ma2.orderBook);
    obData = Buffer.from(obAcct!.data);

    // Find s1's slot by owner key (more robust than hardcoding slot 0)
    let s1SlotActive = false;
    for (let i = 0; i < opl; i++) {
      const s = readOrderSlot(obData, priceLevelIdx(obData, PRICE), i);
      if (s.owner.toBase58() === s1.publicKey.toBase58()) {
        s1SlotActive = s.isActive;
        break;
      }
    }
    expect(s1SlotActive).to.be.false; // Oldest order (t=4000) filled first

    // The new order at t=7000 (slot 1) and order 3 at t=6000 (slot 2) should still be active
    let activeOrders = 0;
    for (let i = 0; i < opl; i++) {
      const s = readOrderSlot(obData, priceLevelIdx(obData, PRICE), i);
      if (s.isActive) activeOrders++;
    }
    expect(activeOrders).to.equal(2); // Two orders remaining (t=6000 and t=7000)

    // Verify USDC proceeds went to s1 (the filled maker), not s2 or s3
    const s1UsdcAfter = await getTokenBalance(ctx, s1Usdc);
    const s2UsdcAfter = await getTokenBalance(ctx, s2Usdc);
    const s3UsdcAfter = await getTokenBalance(ctx, s3Usdc);
    // s1 started with 100M, spent 10M on mint, gets USDC from fill
    expect(s1UsdcAfter).to.be.greaterThan(90_000_000); // got fill proceeds
    // s2 cancelled and re-placed (mint cost + escrow movements), s3 just minted + escrowed
    // Both should NOT have received fill proceeds from this specific buy
    expect(s3UsdcAfter).to.equal(90_000_000); // no fill, just mint cost
  });
});
