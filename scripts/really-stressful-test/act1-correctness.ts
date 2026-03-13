/**
 * act1-correctness.ts — Act 1 of the Really Stressful Test.
 *
 * Proves every instruction type works end-to-end. Creates 7 markets (one per
 * ticker), exercises all instruction types, then settles and closes everything.
 * Fast-fail correctness gate (~90 seconds).
 */

import {
  Transaction,
  Keypair,
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";

import {
  buildCreateStrikeMarketIx,
  buildAllocateOrderBookIx,
  buildSetMarketAltIx,
  buildMintPairIx,
  buildPlaceOrderIx,
  buildCancelOrderIx,
  buildPauseIx,
  buildUnpauseIx,
  buildSettleMarketIx,
  buildAdminSettleIx,
  buildAdminOverrideIx,
  buildRedeemIx,
  buildCrankCancelIx,
  buildCloseMarketIx,
  buildTreasuryRedeemIx,
  buildCleanupMarketIx,
  buildCrankRedeemIx,
  buildUpdatePriceIx,
  padTicker,
  MERIDIAN_PROGRAM_ID,
} from "../../tests/helpers/instructions";

import {
  sendTx,
  batch,
  parseOrderBook,
  readMarketState,
} from "../../scripts/stress-test/helpers";

import {
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findPriceFeed as findPriceFeedPda,
} from "../../services/shared/src/pda";

import { BASE_PRICES } from "../../services/shared/src/synthetic-config";

import type { SharedContext, MarketContext, ActResult, ErrorEntry } from "./types";
import {
  ALLOC_CALLS_REQUIRED,
  ALLOC_BATCH_SIZE,
  ALT_WARMUP_SLEEP_MS,
  MAX_FILLS,
  STRESS_OVERRIDE_WINDOW_S,
  CONFIDENCE_BPS_OF_PRICE,
  DEFAULT_MINT_QUANTITY,
  CRANK_CANCEL_BATCH_SIZE,
  CRANK_REDEEM_MAX_USERS,
} from "./config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Record an instruction type hit in the shared metrics. */
function track(ctx: SharedContext, ixName: string): void {
  ctx.metrics.instructionTypes.add(ixName);
}

/** Record an error entry. */
function recordError(
  errors: ErrorEntry[],
  agentId: number,
  instruction: string,
  message: string,
  market?: string,
): void {
  errors.push({ timestamp: Date.now(), agentId, instruction, market, message });
}

/** Round a dollar price to the nearest $10, expressed in lamports (1e6). */
function roundStrike(priceUsd: number): bigint {
  const rounded = Math.round(priceUsd / 10) * 10;
  return BigInt(rounded) * 1_000_000n;
}

// ---------------------------------------------------------------------------
// Market creation helper
// ---------------------------------------------------------------------------

async function createMarket(
  ctx: SharedContext,
  ticker: string,
  strikeLamports: bigint,
  previousCloseLamports: bigint,
  marketCloseUnix: number,
  day: number,
): Promise<MarketContext> {
  const { connection, admin, configPda, usdcMint } = ctx;

  // 1. Derive all PDAs
  const [market] = findStrikeMarket(ticker, strikeLamports, marketCloseUnix);
  const [yesMint] = findYesMint(market);
  const [noMint] = findNoMint(market);
  const [usdcVault] = findUsdcVault(market);
  const [escrowVault] = findEscrowVault(market);
  const [yesEscrow] = findYesEscrow(market);
  const [noEscrow] = findNoEscrow(market);
  const [orderBook] = findOrderBook(market);
  const [oracleFeed] = findPriceFeedPda(ticker);

  // 2. Allocate order book — 13 calls batched 6/tx
  const allocIxs = [];
  for (let i = 0; i < ALLOC_CALLS_REQUIRED; i++) {
    allocIxs.push(
      buildAllocateOrderBookIx({
        payer: admin.publicKey,
        orderBook,
        marketKey: market,
      }),
    );
  }
  const allocBatches = batch(allocIxs, ALLOC_BATCH_SIZE);
  for (const ixBatch of allocBatches) {
    const tx = new Transaction();
    ixBatch.forEach((ix) => tx.add(ix));
    await sendTx(connection, tx, [admin]);
  }
  track(ctx, "allocate_order_book");

  // 3. Create strike market
  const expiryDay = Math.floor(marketCloseUnix / 86400);
  const createIx = buildCreateStrikeMarketIx({
    admin: admin.publicKey,
    config: configPda,
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
    ticker: padTicker(ticker),
    strikePrice: new BN(strikeLamports.toString()),
    expiryDay,
    marketCloseUnix: new BN(marketCloseUnix),
    previousClose: new BN(previousCloseLamports.toString()),
  });
  const createTx = new Transaction().add(createIx);
  await sendTx(connection, createTx, [admin]);
  track(ctx, "create_strike_market");

  // 4. ALT creation: warmup tx -> createLookupTable -> extendLookupTable -> sleep -> set_market_alt
  // 4a. Warmup — self-transfer to get a recent slot
  const warmupTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: admin.publicKey,
      lamports: 1,
    }),
  );
  await sendTx(connection, warmupTx, [admin]);
  const recentSlot = await connection.getSlot("confirmed");

  // 4b. Create lookup table
  const [createLutIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: admin.publicKey,
    payer: admin.publicKey,
    recentSlot,
  });

  // 4c. Extend with market accounts
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: admin.publicKey,
    authority: admin.publicKey,
    lookupTable: lutAddress,
    addresses: [
      market, yesMint, noMint, usdcVault, escrowVault,
      yesEscrow, noEscrow, orderBook, oracleFeed,
      configPda, ctx.feeVault, ctx.treasury,
    ],
  });

  const lutTx = new Transaction().add(createLutIx, extendIx);
  await sendTx(connection, lutTx, [admin]);

  // 4d. Wait for ALT activation
  await sleep(ALT_WARMUP_SLEEP_MS);

  // 4e. Set market ALT on-chain
  const setAltIx = buildSetMarketAltIx({
    admin: admin.publicKey,
    config: configPda,
    market,
    altAddress: lutAddress,
  });
  const setAltTx = new Transaction().add(setAltIx);
  await sendTx(connection, setAltTx, [admin]);
  track(ctx, "set_market_alt");

  return {
    ticker,
    strikeLamports,
    previousCloseLamports,
    marketCloseUnix,
    market,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
    oracleFeed,
    altAddress: lutAddress,
    day,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Setup markets
// ---------------------------------------------------------------------------

async function act1SetupMarkets(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const marketCloseUnix =
    Math.floor(Date.now() / 1000) + ctx.config.marketCloseOffsetSec;
  const day = Math.floor(marketCloseUnix / 86400);

  for (const ticker of ctx.config.tickers) {
    const basePrice = BASE_PRICES[ticker] ?? 100;
    const strikeLamports = roundStrike(basePrice);
    const previousCloseLamports = BigInt(basePrice) * 1_000_000n;

    try {
      const mc = await createMarket(
        ctx,
        ticker,
        strikeLamports,
        previousCloseLamports,
        marketCloseUnix,
        day,
      );
      ctx.markets.push(mc);
      details.push(`Created market ${ticker} @ strike $${Number(strikeLamports) / 1e6}`);
    } catch (e: any) {
      recordError(errors, -1, "create_market", e.message, ticker);
    }
  }

  details.push(`${ctx.markets.length} / ${ctx.config.tickers.length} markets created`);
}

// ---------------------------------------------------------------------------
// Phase 2: Mint pairs and trade
// ---------------------------------------------------------------------------

async function act1MintAndTrade(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, configPda, feeVault, usdcMint } = ctx;
  const agents = ctx.agents.slice(0, 6);
  const m = ctx.markets[0]; // primary market for trading
  if (!m) return;

  // Helper: get or create all ATAs for an agent on a market
  async function ensureATAs(
    agentKp: Keypair,
    market: MarketContext,
  ): Promise<{ usdc: PublicKey; yes: PublicKey; no: PublicKey }> {
    const usdc = getAssociatedTokenAddressSync(usdcMint, agentKp.publicKey);
    const yes = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        agentKp,
        market.yesMint,
        agentKp.publicKey,
      )
    ).address;
    const no = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        agentKp,
        market.noMint,
        agentKp.publicKey,
      )
    ).address;
    return { usdc, yes, no };
  }

  // Track order IDs placed by agent 0 for later cancel
  let agent0OrderId: bigint | null = null;

  // --- Agents 0-1: mint pairs + place resting bids (side=0, price=45) ---
  for (let i = 0; i < 2; i++) {
    const agent = agents[i];
    try {
      const atas = await ensureATAs(agent.keypair, m);
      const mintIx = buildMintPairIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        usdcVault: m.usdcVault,
        quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
      });
      const mintTx = new Transaction().add(mintIx);
      await sendTx(connection, mintTx, [agent.keypair]);
      track(ctx, "mint_pair");

      const placeIx = buildPlaceOrderIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        feeVault,
        side: 0,
        price: 45,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 2n).toString()),
        orderType: 1,
        maxFills: 0,
      });
      const placeTx = new Transaction().add(placeIx);
      await sendTx(connection, placeTx, [agent.keypair]);
      track(ctx, "place_order");
      agent.ordersPlaced++;

      // Record agent 0's order for later cancellation
      if (i === 0) {
        const obData = await connection.getAccountInfo(m.orderBook);
        if (obData) {
          const orders = parseOrderBook(Buffer.from(obData.data));
          const myOrder = orders.find(
            (o) => o.owner.equals(agent.keypair.publicKey) && o.side === 0,
          );
          if (myOrder) agent0OrderId = myOrder.orderId;
        }
      }
    } catch (e: any) {
      recordError(errors, agent.id, "mint_or_bid", e.message, m.ticker);
    }
  }

  // --- Agents 2-3: mint pairs + place resting asks (side=1, price=55) ---
  for (let i = 2; i < 4; i++) {
    const agent = agents[i];
    try {
      const atas = await ensureATAs(agent.keypair, m);
      const mintIx = buildMintPairIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        usdcVault: m.usdcVault,
        quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
      });
      const mintTx = new Transaction().add(mintIx);
      await sendTx(connection, mintTx, [agent.keypair]);
      track(ctx, "mint_pair");

      const placeIx = buildPlaceOrderIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        feeVault,
        side: 1,
        price: 55,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 2n).toString()),
        orderType: 1,
        maxFills: 0,
      });
      const placeTx = new Transaction().add(placeIx);
      await sendTx(connection, placeTx, [agent.keypair]);
      track(ctx, "place_order");
      agent.ordersPlaced++;
    } catch (e: any) {
      recordError(errors, agent.id, "mint_or_ask", e.message, m.ticker);
    }
  }

  // --- Agent 4: crossing bid (side=0, price=55, maxFills=5) — SEQUENTIAL ---
  {
    const agent = agents[4];
    try {
      const atas = await ensureATAs(agent.keypair, m);
      const mintIx = buildMintPairIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        usdcVault: m.usdcVault,
        quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
      });
      const mintTx = new Transaction().add(mintIx);
      await sendTx(connection, mintTx, [agent.keypair]);
      track(ctx, "mint_pair");

      // Fresh orderbook read for crossing fill maker accounts
      const obAcct = await connection.getAccountInfo(m.orderBook);
      const activeOrders = obAcct
        ? parseOrderBook(Buffer.from(obAcct.data))
        : [];
      // Crossing bid at 55 matches side=1 asks at price <= 55
      const matchingAsks = activeOrders.filter(
        (o) => o.side === 1 && o.priceLevel <= 55,
      );
      // Maker accounts: each ask maker's USDC ATA
      const makerAccounts = matchingAsks.map((o) =>
        getAssociatedTokenAddressSync(usdcMint, o.owner),
      );

      const placeIx = buildPlaceOrderIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        feeVault,
        side: 0,
        price: 55,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 4n).toString()),
        orderType: 1,
        maxFills: MAX_FILLS,
        makerAccounts,
      });
      const placeTx = new Transaction().add(placeIx);
      await sendTx(connection, placeTx, [agent.keypair]);
      track(ctx, "place_order");
      agent.ordersPlaced++;
      agent.ordersFilled++;
      details.push("Agent 4 crossing bid filled against resting asks");
    } catch (e: any) {
      recordError(errors, agent.id, "crossing_bid", e.message, m.ticker);
    }
  }

  // --- Agent 5: mint + sell No (side=2, price=40) ---
  {
    const agent = agents[5];
    try {
      const atas = await ensureATAs(agent.keypair, m);
      const mintIx = buildMintPairIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        usdcVault: m.usdcVault,
        quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
      });
      const mintTx = new Transaction().add(mintIx);
      await sendTx(connection, mintTx, [agent.keypair]);
      track(ctx, "mint_pair");

      const placeIx = buildPlaceOrderIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        feeVault,
        side: 2,
        price: 40,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 4n).toString()),
        orderType: 1,
        maxFills: 0,
      });
      const placeTx = new Transaction().add(placeIx);
      await sendTx(connection, placeTx, [agent.keypair]);
      track(ctx, "place_order");
      agent.ordersPlaced++;
      details.push("Agent 5 placed Sell No (side=2) order");
    } catch (e: any) {
      recordError(errors, agent.id, "sell_no", e.message, m.ticker);
    }
  }

  // --- Agent 0: cancel one of their resting orders ---
  if (agent0OrderId !== null) {
    const agent = agents[0];
    try {
      const atas = await ensureATAs(agent.keypair, m);
      const cancelIx = buildCancelOrderIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        price: 45,
        orderId: new BN(agent0OrderId.toString()),
      });
      const cancelTx = new Transaction().add(cancelIx);
      await sendTx(connection, cancelTx, [agent.keypair]);
      track(ctx, "cancel_order");
      details.push("Agent 0 cancelled resting bid");
    } catch (e: any) {
      recordError(errors, agent.id, "cancel_order", e.message, m.ticker);
    }
  }

  details.push("Minting and trading phase complete");
}

// ---------------------------------------------------------------------------
// Phase 3: Pause / unpause
// ---------------------------------------------------------------------------

async function act1PauseUnpause(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, admin, configPda, feeVault, usdcMint } = ctx;
  const m = ctx.markets[0];
  if (!m) return;

  // Pause market 0
  try {
    const pauseIx = buildPauseIx({
      admin: admin.publicKey,
      config: configPda,
      market: m.market,
    });
    const pauseTx = new Transaction().add(pauseIx);
    await sendTx(connection, pauseTx, [admin]);
    track(ctx, "pause");
    details.push("Paused market 0");
  } catch (e: any) {
    recordError(errors, -1, "pause", e.message, m.ticker);
    return;
  }

  // Try placing an order — expect failure
  const agent = ctx.agents[0];
  const atas = {
    usdc: getAssociatedTokenAddressSync(usdcMint, agent.keypair.publicKey),
    yes: getAssociatedTokenAddressSync(m.yesMint, agent.keypair.publicKey),
    no: getAssociatedTokenAddressSync(m.noMint, agent.keypair.publicKey),
  };
  try {
    const placeIx = buildPlaceOrderIx({
      user: agent.keypair.publicKey,
      config: configPda,
      market: m.market,
      orderBook: m.orderBook,
      usdcVault: m.usdcVault,
      escrowVault: m.escrowVault,
      yesEscrow: m.yesEscrow,
      noEscrow: m.noEscrow,
      yesMint: m.yesMint,
      noMint: m.noMint,
      userUsdcAta: atas.usdc,
      userYesAta: atas.yes,
      userNoAta: atas.no,
      feeVault,
      side: 0,
      price: 50,
      quantity: new BN("1000000"),
      orderType: 1,
      maxFills: 0,
    });
    const placeTx = new Transaction().add(placeIx);
    await sendTx(connection, placeTx, [agent.keypair]);
    // If we get here, pause didn't block — record as error
    recordError(errors, agent.id, "pause_check", "Order succeeded on paused market", m.ticker);
  } catch {
    details.push("Correctly rejected order on paused market");
  }

  // Unpause
  try {
    const unpauseIx = buildUnpauseIx({
      admin: admin.publicKey,
      config: configPda,
      market: m.market,
    });
    const unpauseTx = new Transaction().add(unpauseIx);
    await sendTx(connection, unpauseTx, [admin]);
    track(ctx, "unpause");
    details.push("Unpaused market 0");
  } catch (e: any) {
    recordError(errors, -1, "unpause", e.message, m.ticker);
    return;
  }

  // Place order after unpause — expect success
  try {
    const placeIx = buildPlaceOrderIx({
      user: agent.keypair.publicKey,
      config: configPda,
      market: m.market,
      orderBook: m.orderBook,
      usdcVault: m.usdcVault,
      escrowVault: m.escrowVault,
      yesEscrow: m.yesEscrow,
      noEscrow: m.noEscrow,
      yesMint: m.yesMint,
      noMint: m.noMint,
      userUsdcAta: atas.usdc,
      userYesAta: atas.yes,
      userNoAta: atas.no,
      feeVault,
      side: 0,
      price: 50,
      quantity: new BN("1000000"),
      orderType: 1,
      maxFills: 0,
    });
    const placeTx = new Transaction().add(placeIx);
    await sendTx(connection, placeTx, [agent.keypair]);
    track(ctx, "place_order");
    details.push("Order placed successfully after unpause");
  } catch (e: any) {
    recordError(errors, agent.id, "post_unpause_order", e.message, m.ticker);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Settle markets
// ---------------------------------------------------------------------------

async function act1Settle(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, admin, configPda } = ctx;

  // Wait for market close
  const firstClose = ctx.markets[0]?.marketCloseUnix ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const waitMs = (firstClose - nowSec + 1) * 1000;
  if (waitMs > 0) {
    details.push(`Waiting ${Math.ceil(waitMs / 1000)}s for market close...`);
    await sleep(waitMs);
  }

  // Update oracle prices for all tickers (timestamp = now - 2)
  const oracleTs = Math.floor(Date.now() / 1000) - 2;
  for (const m of ctx.markets) {
    try {
      const priceLamports = m.previousCloseLamports;
      const confidence = BigInt(
        Math.floor(Number(priceLamports) * CONFIDENCE_BPS_OF_PRICE / 10_000),
      );
      const updateIx = buildUpdatePriceIx({
        authority: admin.publicKey,
        priceFeed: m.oracleFeed,
        price: new BN(priceLamports.toString()),
        confidence: new BN(confidence.toString()),
        timestamp: new BN(oracleTs),
      });
      const tx = new Transaction().add(updateIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "update_price");
    } catch (e: any) {
      recordError(errors, -1, "update_price", e.message, m.ticker);
    }
  }

  // Settle 6 markets via settle_market
  for (let i = 0; i < Math.min(6, ctx.markets.length); i++) {
    const m = ctx.markets[i];
    try {
      const settleIx = buildSettleMarketIx({
        caller: admin.publicKey,
        config: configPda,
        market: m.market,
        oracleFeed: m.oracleFeed,
      });
      const tx = new Transaction().add(settleIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "settle_market");
      details.push(`Settled ${m.ticker} via settle_market`);
    } catch (e: any) {
      recordError(errors, -1, "settle_market", e.message, m.ticker);
    }
  }

  // Settle market 6 via admin_settle (wait 5s to simulate delay)
  if (ctx.markets.length >= 7) {
    const m = ctx.markets[6];
    await sleep(5000);
    try {
      const adminSettleIx = buildAdminSettleIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        settlementPrice: new BN(m.previousCloseLamports.toString()),
      });
      const tx = new Transaction().add(adminSettleIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "admin_settle");
      details.push(`Settled ${m.ticker} via admin_settle`);
    } catch (e: any) {
      recordError(errors, -1, "admin_settle", e.message, m.ticker);
    }
  }

  // Override one market's settlement (market 0)
  {
    const m = ctx.markets[0];
    if (m) {
      try {
        const overridePrice = m.strikeLamports + 5_000_000n; // above strike
        const overrideIx = buildAdminOverrideIx({
          admin: admin.publicKey,
          config: configPda,
          market: m.market,
          newSettlementPrice: new BN(overridePrice.toString()),
        });
        const tx = new Transaction().add(overrideIx);
        await sendTx(connection, tx, [admin]);
        track(ctx, "admin_override_settlement");
        details.push(`Overrode settlement on ${m.ticker}`);
      } catch (e: any) {
        recordError(errors, -1, "admin_override_settlement", e.message, m.ticker);
      }
    }
  }

  details.push("Settlement phase complete");
}

// ---------------------------------------------------------------------------
// Phase 5: Redeem
// ---------------------------------------------------------------------------

async function act1Redeem(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, admin, configPda, usdcMint } = ctx;
  const m = ctx.markets[0];
  if (!m) return;

  // Agent 4: redeem mode=1 (winner redemption)
  {
    const agent = ctx.agents[4];
    try {
      const atas = {
        usdc: getAssociatedTokenAddressSync(usdcMint, agent.keypair.publicKey),
        yes: getAssociatedTokenAddressSync(m.yesMint, agent.keypair.publicKey),
        no: getAssociatedTokenAddressSync(m.noMint, agent.keypair.publicKey),
      };
      const redeemIx = buildRedeemIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        usdcVault: m.usdcVault,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        mode: 1,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 8n).toString()),
      });
      const tx = new Transaction().add(redeemIx);
      await sendTx(connection, tx, [agent.keypair]);
      track(ctx, "redeem");
      details.push("Agent 4 redeemed (winner mode)");
    } catch (e: any) {
      recordError(errors, agent.id, "redeem_winner", e.message, m.ticker);
    }
  }

  // Agent 5: redeem mode=0 (pair burn)
  {
    const agent = ctx.agents[5];
    try {
      const atas = {
        usdc: getAssociatedTokenAddressSync(usdcMint, agent.keypair.publicKey),
        yes: getAssociatedTokenAddressSync(m.yesMint, agent.keypair.publicKey),
        no: getAssociatedTokenAddressSync(m.noMint, agent.keypair.publicKey),
      };
      const redeemIx = buildRedeemIx({
        user: agent.keypair.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        usdcVault: m.usdcVault,
        userUsdcAta: atas.usdc,
        userYesAta: atas.yes,
        userNoAta: atas.no,
        mode: 0,
        quantity: new BN((DEFAULT_MINT_QUANTITY / 8n).toString()),
      });
      const tx = new Transaction().add(redeemIx);
      await sendTx(connection, tx, [agent.keypair]);
      track(ctx, "redeem");
      details.push("Agent 5 redeemed (pair burn mode)");
    } catch (e: any) {
      recordError(errors, agent.id, "redeem_pair_burn", e.message, m.ticker);
    }
  }

  // Crank cancel remaining resting orders on market 0
  try {
    const obAcct = await connection.getAccountInfo(m.orderBook);
    if (obAcct) {
      const activeOrders = parseOrderBook(Buffer.from(obAcct.data));
      if (activeOrders.length > 0) {
        // Build remaining_accounts based on order side
        const makerAccounts: PublicKey[] = activeOrders.map((o) => {
          if (o.side === 0) {
            // USDC bid -> maker's USDC ATA
            return getAssociatedTokenAddressSync(usdcMint, o.owner);
          } else if (o.side === 1) {
            // Yes ask -> maker's Yes ATA
            return getAssociatedTokenAddressSync(m.yesMint, o.owner);
          } else {
            // No bid (side=2) -> maker's No ATA
            return getAssociatedTokenAddressSync(m.noMint, o.owner);
          }
        });

        const crankIx = buildCrankCancelIx({
          caller: admin.publicKey,
          config: configPda,
          market: m.market,
          orderBook: m.orderBook,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          batchSize: Math.min(activeOrders.length, CRANK_CANCEL_BATCH_SIZE),
          makerAccounts,
        });
        const tx = new Transaction().add(crankIx);
        await sendTx(connection, tx, [admin]);
        track(ctx, "crank_cancel");
        details.push(`Crank-cancelled ${activeOrders.length} resting orders`);
      }
    }
  } catch (e: any) {
    recordError(errors, -1, "crank_cancel", e.message, m.ticker);
  }

  // Crank redeem winning holders on market 0
  // Determine outcome to pick the winning token mint
  try {
    const state = await readMarketState(connection, m.market);
    if (state && state.isSettled) {
      // outcome: 0 = Yes wins (price >= strike), 1 = No wins
      const winMint = state.outcome === 0 ? m.yesMint : m.noMint;

      // Build remaining accounts: pairs of [winningTokenATA, usdcATA] per holder
      const holders: PublicKey[] = [];
      const agents = ctx.agents.slice(0, 6);
      const remainingAccounts: {
        pubkey: PublicKey;
        isSigner: boolean;
        isWritable: boolean;
      }[] = [];
      let pairCount = 0;

      for (const agent of agents) {
        const winAta = getAssociatedTokenAddressSync(
          winMint,
          agent.keypair.publicKey,
        );
        const usdcAta = getAssociatedTokenAddressSync(
          usdcMint,
          agent.keypair.publicKey,
        );
        remainingAccounts.push(
          { pubkey: winAta, isSigner: false, isWritable: true },
          { pubkey: usdcAta, isSigner: false, isWritable: true },
        );
        pairCount++;
        if (pairCount >= CRANK_REDEEM_MAX_USERS) break;
      }

      if (pairCount > 0) {
        const crankRedeemIx = buildCrankRedeemIx(
          {
            caller: admin.publicKey,
            config: configPda,
            market: m.market,
            yesMint: m.yesMint,
            noMint: m.noMint,
            usdcVault: m.usdcVault,
          },
          pairCount,
          remainingAccounts,
        );
        const tx = new Transaction().add(crankRedeemIx);
        await sendTx(connection, tx, [admin]);
        track(ctx, "crank_redeem");
        details.push(`Crank-redeemed ${pairCount} holders`);
      }
    }
  } catch (e: any) {
    recordError(errors, -1, "crank_redeem", e.message, m.ticker);
  }

  details.push("Redemption phase complete");
}

// ---------------------------------------------------------------------------
// Phase 6: Close markets
// ---------------------------------------------------------------------------

async function act1Close(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, admin, configPda, treasury, usdcMint } = ctx;

  // Wait for override window to expire on all settled markets
  for (const m of ctx.markets) {
    try {
      const state = await readMarketState(connection, m.market);
      if (state && state.isSettled) {
        const waitSec =
          Number(state.overrideDeadline) - Math.floor(Date.now() / 1000) + 1;
        if (waitSec > 0 && waitSec <= 30) {
          details.push(
            `Waiting ${waitSec}s for override window on ${m.ticker}...`,
          );
          await sleep(waitSec * 1000);
        }
      }
    } catch {
      // If we can't read state, continue and let close_market fail if needed
    }
  }

  // Close all 7 markets
  for (const m of ctx.markets) {
    try {
      const closeIx = buildCloseMarketIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        treasury,
      });
      const tx = new Transaction().add(closeIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "close_market");
    } catch (e: any) {
      recordError(errors, -1, "close_market", e.message, m.ticker);
    }
  }
  details.push(`Closed ${ctx.markets.length} markets`);

  // Treasury redeem on market 0
  if (ctx.markets.length > 0) {
    const m = ctx.markets[0];
    try {
      const adminUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        admin.publicKey,
      );
      const adminYesAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          m.yesMint,
          admin.publicKey,
        )
      ).address;
      const adminNoAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          m.noMint,
          admin.publicKey,
        )
      ).address;

      const treasuryRedeemIx = buildTreasuryRedeemIx({
        user: admin.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        treasury,
        userUsdcAta: adminUsdcAta,
        userYesAta: adminYesAta,
        userNoAta: adminNoAta,
      });
      const tx = new Transaction().add(treasuryRedeemIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "treasury_redeem");
      details.push("Treasury redeem on market 0");
    } catch (e: any) {
      recordError(errors, -1, "treasury_redeem", e.message, m.ticker);
    }
  }

  // Cleanup all markets
  for (const m of ctx.markets) {
    try {
      const cleanupIx = buildCleanupMarketIx({
        admin: admin.publicKey,
        config: configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
      });
      const tx = new Transaction().add(cleanupIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "cleanup_market");
    } catch (e: any) {
      recordError(errors, -1, "cleanup_market", e.message, m.ticker);
    }
  }
  details.push(`Cleaned up ${ctx.markets.length} markets`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAct1(ctx: SharedContext): Promise<ActResult> {
  const startMs = Date.now();
  const errors: ErrorEntry[] = [];
  const details: string[] = [];

  details.push("=== Act 1: Correctness ===");

  try {
    // Phase 1: Create 7 markets
    details.push("--- Phase 1: Setup Markets ---");
    await act1SetupMarkets(ctx, errors, details);
    if (ctx.markets.length === 0) {
      throw new Error("No markets created — cannot continue");
    }

    // Phase 2: Mint and trade
    details.push("--- Phase 2: Mint & Trade ---");
    await act1MintAndTrade(ctx, errors, details);

    // Phase 3: Pause / unpause
    details.push("--- Phase 3: Pause / Unpause ---");
    await act1PauseUnpause(ctx, errors, details);

    // Phase 4: Settle
    details.push("--- Phase 4: Settlement ---");
    await act1Settle(ctx, errors, details);

    // Phase 5: Redeem
    details.push("--- Phase 5: Redemption ---");
    await act1Redeem(ctx, errors, details);

    // Phase 6: Close
    details.push("--- Phase 6: Close & Cleanup ---");
    await act1Close(ctx, errors, details);
  } catch (e: any) {
    recordError(errors, -1, "act1_fatal", e.message);
    details.push(`FATAL: ${e.message}`);
  }

  const duration = Date.now() - startMs;
  const passed = errors.length === 0;

  details.push(
    `Instruction types exercised: ${ctx.metrics.instructionTypes.size}`,
  );
  details.push(`Duration: ${(duration / 1000).toFixed(1)}s`);
  details.push(`Result: ${passed ? "PASS" : "FAIL"} (${errors.length} errors)`);

  return {
    name: "Act 1: Correctness",
    passed,
    duration,
    details,
    errors,
  };
}
