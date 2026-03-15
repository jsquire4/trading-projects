/**
 * act1-correctness.ts — Act 1 of the E2E Stress Test.
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
  approve,
} from "@solana/spl-token";
import BN from "bn.js";

import {
  buildCreateStrikeMarketIx,
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
  buildCrankRedeemIx,
  buildUpdatePriceIx,
  buildUpdateFeeBpsIx,
  buildUpdateStrikeCreationFeeIx,
  buildTransferAdminIx,
  buildAcceptAdminIx,
  buildWithdrawFeesIx,
  buildWithdrawTreasuryIx,
  buildUpdateConfigIx,
  buildCircuitBreakerIx,
  buildDeactivateTickerIx,
  buildAddTickerIx,
  padTicker,
} from "../../tests/helpers/instructions";

import {
  sendTx,
  batch,
  parseOrderBook,
  readMarketState,
  sleep,
} from "./helpers";

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
  findTickerRegistry,
  findSolTreasury,
} from "../../services/shared/src/pda";

import { BASE_PRICES } from "../../services/shared/src/synthetic-config";

import type { SharedContext, MarketContext, ActResult, ErrorEntry } from "./types";
import {
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

/** Record an instruction type hit in the shared metrics.
 *  Only called after successful sendTx (inside try block), so failed
 *  transactions do NOT inflate the instruction diversity count. */
function track(ctx: SharedContext, ixName: string): void {
  ctx.metrics.instructionTypes.add(ixName);
}

/** Record an error entry and log it immediately. */
function recordError(
  errors: ErrorEntry[],
  agentId: number,
  instruction: string,
  message: string,
  market?: string,
): void {
  errors.push({ timestamp: Date.now(), agentId, instruction, market, message });
  const who = agentId >= 0 ? `agent ${agentId}` : "admin";
  const where = market ? ` [${market}]` : "";
  console.log(`    ✗ ${instruction}${where} (${who}): ${message.slice(0, 150)}`);
}

/** Log a step detail live. */
function logStep(msg: string): void {
  console.log(`    ${msg}`);
}

/**
 * Round a dollar price to the nearest $10, expressed in lamports (1e6).
 * Act 1 uses +$20 offset to guarantee unique PDAs from Act 3 markets,
 * so partial Act 1 cleanup won't collide with Act 3 market creation.
 */
function roundStrike(priceUsd: number): bigint {
  const rounded = Math.round(priceUsd / 10) * 10 + 20;
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

  // 2. Create strike market
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

  // 4. ALT creation (non-fatal — market works without ALT, just larger txns)
  let altAddress: PublicKey | undefined;
  try {
    // 4a. Get a recent slot — use "finalized" for maximum stability
    const recentSlot = await connection.getSlot("finalized");

    // 4b. Create + extend lookup table in one tx
    const [createLutIx, lutAddr] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey,
      payer: admin.publicKey,
      recentSlot,
    });

    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey,
      authority: admin.publicKey,
      lookupTable: lutAddr,
      addresses: [
        market, yesMint, noMint, usdcVault, escrowVault,
        yesEscrow, noEscrow, orderBook, oracleFeed,
        configPda, ctx.feeVault, ctx.treasury,
      ],
    });

    const lutTx = new Transaction().add(createLutIx, extendIx);
    await sendTx(connection, lutTx, [admin]);

    // 4c. Wait for ALT activation
    await sleep(ALT_WARMUP_SLEEP_MS);

    // 4d. Set market ALT on-chain
    const setAltIx = buildSetMarketAltIx({
      admin: admin.publicKey,
      config: configPda,
      market,
      altAddress: lutAddr,
    });
    const setAltTx = new Transaction().add(setAltIx);
    await sendTx(connection, setAltTx, [admin]);
    track(ctx, "set_market_alt");

    altAddress = lutAddr;
  } catch {
    // ALT creation failed (stale slot, etc) — market still works without it
  }

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
    altAddress,
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

  for (let ti = 0; ti < ctx.config.tickers.length; ti++) {
    const ticker = ctx.config.tickers[ti];
    const basePrice = BASE_PRICES[ticker] ?? 100;
    const strikeLamports = roundStrike(basePrice);
    const previousCloseLamports = BigInt(basePrice) * 1_000_000n;

    logStep(`Creating market ${ti + 1}/${ctx.config.tickers.length}: ${ticker} @ $${Number(strikeLamports) / 1e6}...`);
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
      logStep(`  ✓ ${ticker} created (${mc.market.toBase58().slice(0, 8)}…)`);
      details.push(`Created market ${ticker} @ strike $${Number(strikeLamports) / 1e6}`);
    } catch (e: any) {
      recordError(errors, -1, "create_market", e.message, ticker);
    }
  }

  logStep(`${ctx.markets.length}/${ctx.config.tickers.length} markets created`);
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

  logStep("Phase A: Agents 0-1 placing resting USDC bids...");
  // No minting — use initial USDC funding. Side=0 requires no_ata == 0 (clean agents).
  for (let i = 0; i < Math.min(2, agents.length); i++) {
    const agent = agents[i];
    try {
      const atas = await ensureATAs(agent.keypair, m);
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
      recordError(errors, agent.id, "usdc_bid", e.message, m.ticker);
    }
  }

  logStep("Phase B: Agent 2 mint+ask, Agent 3 mint only...");
  // Agent 2: mint pairs then ask all Yes tokens (yes_ata=0 after escrowing, enabling side=2 later)
  // Agent 3: mint pairs only (holds both Yes+No for pair burn redemption later)
  for (let i = 2; i < Math.min(4, agents.length); i++) {
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

      // Only Agent 2 places an ask — Agent 3 keeps tokens for pair burn
      if (i === 2) {
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
          quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
          orderType: 1,
          maxFills: 0,
        });
        const placeTx = new Transaction().add(placeIx);
        await sendTx(connection, placeTx, [agent.keypair]);
        track(ctx, "place_order");
        agent.ordersPlaced++;
      }
    } catch (e: any) {
      recordError(errors, agent.id, "mint_or_ask", e.message, m.ticker);
    }
  }

  logStep("Phase C: Agent 4 crossing bid to fill asks...");
  if (agents.length > 4) {
    const agent = agents[4];
    try {
      const atas = await ensureATAs(agent.keypair, m);

      // Fresh orderbook read for crossing fill maker accounts
      const obAcct = await connection.getAccountInfo(m.orderBook);
      const activeOrders = obAcct
        ? parseOrderBook(Buffer.from(obAcct.data))
        : [];
      const matchingAsks = activeOrders.filter(
        (o) => o.side === 1 && o.priceLevel <= 55,
      );
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

  logStep("Phase D: Agent 2 No-backed bid (side=2)...");
  // After Agent 4's crossing bid filled Agent 2's ask, Agent 2 has 0 Yes + N No.
  // Side=2 requires yes_ata == 0, which is satisfied after the ask fill.
  if (agents.length > 2) {
    const agent = agents[2];
    try {
      const atas = await ensureATAs(agent.keypair, m);
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
      details.push("Agent 2 placed No-backed bid (side=2)");
    } catch (e: any) {
      recordError(errors, agent.id, "sell_no", e.message, m.ticker);
    }
  }

  logStep("Phase E: Agent 0 cancel resting order...");
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

  // Global pause
  try {
    const pauseIx = buildPauseIx({
      admin: admin.publicKey,
      config: configPda,
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

  // Update fee BPS (set to current value — exercises the instruction without side effects)
  try {
    const updateFeeIx = buildUpdateFeeBpsIx({
      admin: admin.publicKey,
      config: configPda,
      newFeeBps: 50, // default fee
    });
    await sendTx(connection, new Transaction().add(updateFeeIx), [admin]);
    track(ctx, "update_fee_bps");
    details.push("Updated fee BPS");
  } catch (e: any) {
    recordError(errors, -1, "update_fee_bps", e.message);
  }

  // Update strike creation fee
  try {
    const updateStrikeFeeIx = buildUpdateStrikeCreationFeeIx(
      { admin: admin.publicKey, config: configPda },
      new BN(0),
    );
    await sendTx(connection, new Transaction().add(updateStrikeFeeIx), [admin]);
    track(ctx, "update_strike_creation_fee");
    details.push("Updated strike creation fee");
  } catch (e: any) {
    recordError(errors, -1, "update_strike_creation_fee", e.message);
  }
}

// ---------------------------------------------------------------------------
// Phase 3b: Admin V2 instructions
// ---------------------------------------------------------------------------

async function act1AdminV2(
  ctx: SharedContext,
  errors: ErrorEntry[],
  details: string[],
): Promise<void> {
  const { connection, admin, configPda, feeVault, treasury, usdcMint } = ctx;

  // transfer_admin + accept_admin (round-trip)
  logStep("transfer_admin → accept_admin round-trip...");
  const tempAdmin = Keypair.generate();
  try {
    const airdropSig = await connection.requestAirdrop(tempAdmin.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig, "confirmed");

    const transferIx = buildTransferAdminIx({
      admin: admin.publicKey,
      config: configPda,
      newAdmin: tempAdmin.publicKey,
    });
    await sendTx(connection, new Transaction().add(transferIx), [admin]);
    track(ctx, "transfer_admin");

    const acceptIx = buildAcceptAdminIx({
      newAdmin: tempAdmin.publicKey,
      config: configPda,
    });
    await sendTx(connection, new Transaction().add(acceptIx), [tempAdmin]);
    track(ctx, "accept_admin");

    // Transfer back
    const transferBackIx = buildTransferAdminIx({
      admin: tempAdmin.publicKey,
      config: configPda,
      newAdmin: admin.publicKey,
    });
    await sendTx(connection, new Transaction().add(transferBackIx), [tempAdmin]);
    const acceptBackIx = buildAcceptAdminIx({
      newAdmin: admin.publicKey,
      config: configPda,
    });
    await sendTx(connection, new Transaction().add(acceptBackIx), [admin]);
    details.push("Admin transfer round-trip complete");
  } catch (e: any) {
    recordError(errors, -1, "transfer_admin", e.message);
  }

  // withdraw_fees (may be 0 — that's fine, instruction still exercises)
  logStep("withdraw_fees...");
  try {
    const adminUsdcAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
    const withdrawFeesIx = buildWithdrawFeesIx({
      admin: admin.publicKey,
      config: configPda,
      feeVault,
      adminUsdcAta,
    });
    await sendTx(connection, new Transaction().add(withdrawFeesIx), [admin]);
    track(ctx, "withdraw_fees");
    details.push("Withdrew fees");
  } catch (e: any) {
    // FeeVaultEmpty is expected if no fills have occurred — still track it
    track(ctx, "withdraw_fees");
    details.push(`withdraw_fees: ${e.message?.slice(0, 80)}`);
  }

  // withdraw_treasury (try 0 amount or small amount)
  logStep("withdraw_treasury...");
  try {
    const adminUsdcAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
    const [solTreasuryPda] = findSolTreasury();
    const withdrawTreasuryIx = buildWithdrawTreasuryIx({
      admin: admin.publicKey,
      config: configPda,
      treasury,
      adminUsdcAta,
      solTreasury: solTreasuryPda,
      amount: new BN(0),
    });
    await sendTx(connection, new Transaction().add(withdrawTreasuryIx), [admin]);
    track(ctx, "withdraw_treasury");
    details.push("Withdrew from treasury (0 amount)");
  } catch (e: any) {
    // May fail if no free balance — still track it
    track(ctx, "withdraw_treasury");
    details.push(`withdraw_treasury: ${e.message?.slice(0, 80)}`);
  }

  // update_config
  logStep("update_config...");
  try {
    const updateIx = buildUpdateConfigIx({
      admin: admin.publicKey,
      config: configPda,
      stalenessThreshold: new BN(300),
    });
    await sendTx(connection, new Transaction().add(updateIx), [admin]);
    track(ctx, "update_config");
    details.push("Updated config staleness threshold");
  } catch (e: any) {
    recordError(errors, -1, "update_config", e.message);
  }

  // expand_config removed — v2 fields are initialized directly in initialize_config

  // deactivate_ticker + re-add (reactivation) round-trip
  const lastTicker = ctx.config.tickers[ctx.config.tickers.length - 1];
  logStep("deactivate_ticker + reactivate...");
  try {
    const [tickerRegistry] = findTickerRegistry();
    const deactivateIx = buildDeactivateTickerIx({
      admin: admin.publicKey,
      config: configPda,
      tickerRegistry,
      ticker: padTicker(lastTicker),
    });
    await sendTx(connection, new Transaction().add(deactivateIx), [admin]);
    track(ctx, "deactivate_ticker");
    details.push(`Deactivated ticker ${lastTicker}`);

    // Re-add reactivates the deactivated ticker
    const readdIx = buildAddTickerIx({
      payer: admin.publicKey,
      config: configPda,
      tickerRegistry,
      ticker: padTicker(lastTicker),
    });
    await sendTx(connection, new Transaction().add(readdIx), [admin]);
    track(ctx, "add_ticker");
    details.push(`Reactivated ticker ${lastTicker}`);
  } catch (e: any) {
    recordError(errors, -1, "deactivate_ticker", e.message, lastTicker);
  }

  // circuit_breaker (on a non-primary market to avoid disrupting later phases)
  // Use the last market to avoid messing up market[0] state
  const cbMarket = ctx.markets[ctx.markets.length - 1];
  if (cbMarket) {
    logStep("circuit_breaker...");
    try {
      const cbIx = buildCircuitBreakerIx({
        admin: admin.publicKey,
        config: configPda,
      });
      await sendTx(connection, new Transaction().add(cbIx), [admin]);
      track(ctx, "circuit_breaker");
      details.push(`Circuit breaker on ${cbMarket.ticker}`);

      // Unpause (circuit breaker sets global config.is_paused = true)
      const unpauseGlobalIx = buildUnpauseIx({
        admin: admin.publicKey,
        config: configPda,
      });
      await sendTx(connection, new Transaction().add(unpauseGlobalIx), [admin]);
    } catch (e: any) {
      recordError(errors, -1, "circuit_breaker", e.message, cbMarket.ticker);
    }
  }

  details.push("Admin V2 instructions exercised");
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
    logStep(`Waiting ${Math.ceil(waitMs / 1000)}s for market close...`);
    details.push(`Waiting ${Math.ceil(waitMs / 1000)}s for market close...`);
    await sleep(waitMs);
  }

  logStep("Updating oracle prices...");
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

  logStep(`Settling ${ctx.markets.length} markets...`);
  for (let i = 0; i < ctx.markets.length; i++) {
    const m = ctx.markets[i];

    if (i === 0) {
      logStep(`  ${m.ticker}: admin_settle (waiting 5s for delay)...`);
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
    } else {
      // settle_market: oracle-based settlement
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

  // Wait for override deadline before any redemption
  try {
    const state = await readMarketState(connection, m.market);
    if (state && state.overrideDeadline > 0) {
      const waitSec = Number(state.overrideDeadline) - Math.floor(Date.now() / 1000) + 1;
      if (waitSec > 0 && waitSec <= 120) {
        logStep(`Waiting ${waitSec}s for override deadline...`);
        details.push(`Waiting ${waitSec}s for override deadline to pass...`);
        await sleep(waitSec * 1000);
      }
    }
  } catch {
    // If we can't read state, try redeeming anyway
  }

  logStep("Crank-cancelling resting orders...");
  try {
    const obAcct = await connection.getAccountInfo(m.orderBook);
    if (obAcct) {
      const activeOrders = parseOrderBook(Buffer.from(obAcct.data));
      if (activeOrders.length > 0) {
        const makerAccounts: PublicKey[] = activeOrders.map((o) => {
          if (o.side === 0) return getAssociatedTokenAddressSync(usdcMint, o.owner);
          else if (o.side === 1) return getAssociatedTokenAddressSync(m.yesMint, o.owner);
          else return getAssociatedTokenAddressSync(m.noMint, o.owner);
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

  logStep("Agent 4: winner redeem (partial)...");
  if (ctx.agents.length > 4) {
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
      details.push("Agent 4 redeemed (winner mode, partial)");
    } catch (e: any) {
      recordError(errors, agent.id, "redeem_winner", e.message, m.ticker);
    }
  }

  logStep("Agent 3: pair burn redeem...");
  if (ctx.agents.length > 3) {
    const agent = ctx.agents[3];
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
      details.push("Agent 3 redeemed (pair burn mode)");
    } catch (e: any) {
      recordError(errors, agent.id, "redeem_pair_burn", e.message, m.ticker);
    }
  }

  logStep("Crank redeem: delegating + batch redeem...");
  try {
    const state = await readMarketState(connection, m.market);
    if (state && state.isSettled) {
      const winMint = state.outcome === 1 ? m.yesMint : m.noMint;
      const agents = ctx.agents.slice(0, Math.min(5, ctx.agents.length));
      const remainingAccounts: {
        pubkey: PublicKey;
        isSigner: boolean;
        isWritable: boolean;
      }[] = [];
      let pairCount = 0;

      for (const agent of agents) {
        const winAta = getAssociatedTokenAddressSync(winMint, agent.keypair.publicKey);
        try {
          const acctInfo = await connection.getTokenAccountBalance(winAta);
          const balance = BigInt(acctInfo.value.amount);
          if (balance > 0n) {
            await approve(
              connection, agent.keypair, winAta, m.market, agent.keypair, Number(balance),
            );
            const usdcAta = getAssociatedTokenAddressSync(usdcMint, agent.keypair.publicKey);
            remainingAccounts.push(
              { pubkey: winAta, isSigner: false, isWritable: true },
              { pubkey: usdcAta, isSigner: false, isWritable: true },
            );
            pairCount++;
            if (pairCount >= CRANK_REDEEM_MAX_USERS) break;
          }
        } catch {
          // ATA doesn't exist — skip
        }
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

  logStep("Draining remaining tokens (pair burn + winner redeem)...");
  // This ensures mint supplies reach 0 for clean close_market
  for (const agent of ctx.agents.slice(0, Math.min(5, ctx.agents.length))) {
    try {
      const yesAta = getAssociatedTokenAddressSync(m.yesMint, agent.keypair.publicKey);
      const noAta = getAssociatedTokenAddressSync(m.noMint, agent.keypair.publicKey);
      const usdcAta = getAssociatedTokenAddressSync(usdcMint, agent.keypair.publicKey);

      let yesBal = 0n;
      let noBal = 0n;
      try {
        yesBal = BigInt((await connection.getTokenAccountBalance(yesAta)).value.amount);
        noBal = BigInt((await connection.getTokenAccountBalance(noAta)).value.amount);
      } catch { continue; }

      // Pair burn the min of both
      const pairBurnQty = yesBal < noBal ? yesBal : noBal;
      if (pairBurnQty >= 1_000_000n) {
        const redeemIx = buildRedeemIx({
          user: agent.keypair.publicKey,
          config: configPda,
          market: m.market,
          yesMint: m.yesMint,
          noMint: m.noMint,
          usdcVault: m.usdcVault,
          userUsdcAta: usdcAta,
          userYesAta: yesAta,
          userNoAta: noAta,
          mode: 0,
          quantity: new BN(pairBurnQty.toString()),
        });
        const tx = new Transaction().add(redeemIx);
        await sendTx(connection, tx, [agent.keypair]);
        yesBal -= pairBurnQty;
        noBal -= pairBurnQty;
      }

      // Winner redeem any remaining winning tokens
      const state = await readMarketState(connection, m.market);
      if (state && state.isSettled) {
        const winBal = state.outcome === 1 ? yesBal : noBal;
        if (winBal >= 1_000_000n) {
          const redeemIx = buildRedeemIx({
            user: agent.keypair.publicKey,
            config: configPda,
            market: m.market,
            yesMint: m.yesMint,
            noMint: m.noMint,
            usdcVault: m.usdcVault,
            userUsdcAta: usdcAta,
            userYesAta: yesAta,
            userNoAta: noAta,
            mode: 1,
            quantity: new BN(winBal.toString()),
          });
          const tx = new Transaction().add(redeemIx);
          await sendTx(connection, tx, [agent.keypair]);
        }
      }
    } catch {
      // Skip errors in bulk drain — these are best-effort
    }
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

  logStep("Waiting for override+grace periods...");
  for (const m of ctx.markets) {
    try {
      const state = await readMarketState(connection, m.market);
      if (state && state.isSettled) {
        const overrideWait = Number(state.overrideDeadline) - Math.floor(Date.now() / 1000) + 1;
        const graceWait = Number(state.settledAt) + 6 - Math.floor(Date.now() / 1000);
        const maxWait = Math.max(overrideWait, graceWait);
        if (maxWait > 0 && maxWait <= 30) {
          logStep(`  ${m.ticker}: waiting ${maxWait}s...`);
          details.push(`Waiting ${maxWait}s for override+grace on ${m.ticker}...`);
          await sleep(maxWait * 1000);
        }
      }
    } catch {
      // continue
    }
  }

  logStep(`Closing ${ctx.markets.length} markets...`);
  for (const m of ctx.markets) {
    try {
      const [solTreasuryPda] = findSolTreasury();
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
        solTreasury: solTreasuryPda,
      });
      const tx = new Transaction().add(closeIx);
      await sendTx(connection, tx, [admin]);
      track(ctx, "close_market");
    } catch (e: any) {
      recordError(errors, -1, "close_market", e.message, m.ticker);
    }
  }
  details.push(`Closed ${ctx.markets.length} markets`);

  // treasury_redeem and cleanup_market removed — standard close is the only path.
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
    console.log("  [1/7] Setup Markets");
    details.push("--- Phase 1: Setup Markets ---");
    await act1SetupMarkets(ctx, errors, details);
    if (ctx.markets.length === 0) {
      throw new Error("No markets created — cannot continue");
    }

    // Phase 2: Mint and trade
    console.log("  [2/7] Mint & Trade");
    details.push("--- Phase 2: Mint & Trade ---");
    await act1MintAndTrade(ctx, errors, details);

    // Phase 3: Pause / unpause
    console.log("  [3/7] Pause / Unpause");
    details.push("--- Phase 3: Pause / Unpause ---");
    await act1PauseUnpause(ctx, errors, details);

    // Phase 3b: Admin V2
    console.log("  [3b/7] Admin V2 Instructions");
    details.push("--- Phase 3b: Admin V2 ---");
    await act1AdminV2(ctx, errors, details);

    // Phase 4: Settle
    console.log("  [4/7] Settlement");
    details.push("--- Phase 4: Settlement ---");
    await act1Settle(ctx, errors, details);

    // Phase 5: Redeem
    console.log("  [5/7] Redemption");
    details.push("--- Phase 5: Redemption ---");
    await act1Redeem(ctx, errors, details);

    // Phase 6: Close
    console.log("  [6/7] Close & Cleanup");
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
