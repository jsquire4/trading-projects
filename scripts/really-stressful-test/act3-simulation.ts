/**
 * act3-simulation.ts — Multi-day trading simulation orchestrator.
 *
 * For each simulated day:
 *   1. Create markets (1 per ticker at ATM strike)
 *   2. Update oracle prices
 *   3. Seed liquidity (market makers mint + post)
 *   4. Trading loop (all agents act randomly until window closes)
 *   5. Wait for market close
 *   6. Settle all markets
 *   7. Crank cancel resting orders
 *   8. Crank redeem winning holders
 *   9. Close markets
 *   10. Verify end-of-day
 */

import {
  Transaction,
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";

import type {
  SharedContext,
  MarketContext,
  ActResult,
  ErrorEntry,
  DayResult,
} from "./types";
import {
  ALLOC_CALLS_REQUIRED,
  ALLOC_BATCH_SIZE,
  ALT_WARMUP_SLEEP_MS,
  STRESS_ADMIN_SETTLE_DELAY_S,
  STRESS_OVERRIDE_WINDOW_S,
  CONFIDENCE_BPS_OF_PRICE,
  DEFAULT_MINT_QUANTITY,
  CRANK_CANCEL_BATCH_SIZE,
  CRANK_REDEEM_MAX_USERS,
  MAX_FILLS,
} from "./config";
import {
  buildAllocateOrderBookIx,
  buildCreateStrikeMarketIx,
  buildSetMarketAltIx,
  buildSettleMarketIx,
  buildAdminSettleIx,
  buildAdminOverrideIx,
  buildCrankCancelIx,
  buildCrankRedeemIx,
  buildCloseMarketIx,
  buildTreasuryRedeemIx,
  buildCleanupMarketIx,
  buildUpdatePriceIx,
  padTicker,
} from "../../tests/helpers/instructions";
import {
  sendTx,
  batch,
  parseOrderBook,
  readMarketState,
  findPriceFeed,
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
} from "../../services/shared/src/pda";
import { BASE_PRICES, SeededRng, hashSeed } from "../../services/shared/src/synthetic-config";

import { OracleSimulator } from "./oracle";
import { MetricsCollector } from "./metrics";
import { verifyDayEnd, verifyCrossDay } from "./verification";
import { MarketMaker } from "./agents/market-maker";
import { Directional } from "./agents/directional";
import { Scalper } from "./agents/scalper";
import { StrikeCreator } from "./agents/strike-creator";
import type { BaseAgent } from "./agents/base-agent";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Market creation helper ─────────────────────────────────────────────────

async function createDayMarkets(
  ctx: SharedContext,
  day: number,
  marketCloseUnix: number,
  oracle: OracleSimulator,
): Promise<MarketContext[]> {
  const markets: MarketContext[] = [];

  for (const ticker of ctx.config.tickers) {
    const priceLamports = oracle.getPriceLamports(ticker);
    // Round to nearest $10 (10_000_000 lamports)
    const strikeLamports = BigInt(Math.round(Number(priceLamports) / 10_000_000) * 10_000_000);
    const previousCloseLamports = priceLamports;

    try {
      const m = await createMarket(ctx, ticker, strikeLamports, previousCloseLamports, marketCloseUnix, day);
      markets.push(m);
      ctx.markets.push(m);
      ctx.metrics.instructionTypes.add("allocate_order_book");
      ctx.metrics.instructionTypes.add("create_strike_market");
      ctx.metrics.instructionTypes.add("set_market_alt");
    } catch (e: any) {
      console.log(`  WARNING: Failed to create market for ${ticker} day ${day}: ${e.message}`);
    }
  }

  return markets;
}

async function createMarket(
  ctx: SharedContext,
  ticker: string,
  strikeLamports: bigint,
  previousCloseLamports: bigint,
  marketCloseUnix: number,
  day: number,
): Promise<MarketContext> {
  const expiryDay = Math.floor(marketCloseUnix / 86400);
  const [market] = findStrikeMarket(ticker, strikeLamports, marketCloseUnix);
  const [yesMint] = findYesMint(market);
  const [noMint] = findNoMint(market);
  const [usdcVault] = findUsdcVault(market);
  const [escrowVault] = findEscrowVault(market);
  const [yesEscrow] = findYesEscrow(market);
  const [noEscrow] = findNoEscrow(market);
  const [orderBook] = findOrderBook(market);
  const [oracleFeed] = findPriceFeed(ticker);

  // 1. Allocate order book (13 calls, batched 6/tx)
  const allocIxs = [];
  for (let i = 0; i < ALLOC_CALLS_REQUIRED; i++) {
    allocIxs.push(
      buildAllocateOrderBookIx({
        payer: ctx.admin.publicKey,
        orderBook,
        marketKey: market,
      }),
    );
  }
  const allocBatches = batch(allocIxs, ALLOC_BATCH_SIZE);
  for (const group of allocBatches) {
    const tx = new Transaction();
    for (const ix of group) tx.add(ix);
    await sendTx(ctx.connection, tx, [ctx.admin]);
  }

  // 2. Create strike market
  const createIx = buildCreateStrikeMarketIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    market,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
    oracleFeed,
    usdcMint: ctx.usdcMint,
    ticker: padTicker(ticker),
    strikePrice: new BN(strikeLamports.toString()),
    expiryDay,
    marketCloseUnix: new BN(marketCloseUnix),
    previousClose: new BN(previousCloseLamports.toString()),
  });
  const createTx = new Transaction().add(createIx);
  await sendTx(ctx.connection, createTx, [ctx.admin]);

  // 3. ALT creation
  let altAddress: PublicKey | undefined;
  try {
    // Warmup tx
    const warmupTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ctx.admin.publicKey,
        toPubkey: ctx.admin.publicKey,
        lamports: 1,
      }),
    );
    await sendTx(ctx.connection, warmupTx, [ctx.admin]);
    const slot = await ctx.connection.getSlot("confirmed");

    // Create ALT
    const [createAltIx, altPubkey] = AddressLookupTableProgram.createLookupTable({
      authority: ctx.admin.publicKey,
      payer: ctx.admin.publicKey,
      recentSlot: slot,
    });
    const altTx = new Transaction().add(createAltIx);
    await sendTx(ctx.connection, altTx, [ctx.admin]);

    // Extend ALT
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: altPubkey,
      authority: ctx.admin.publicKey,
      payer: ctx.admin.publicKey,
      addresses: [
        market, yesMint, noMint, usdcVault, escrowVault,
        yesEscrow, noEscrow, orderBook, oracleFeed,
      ],
    });
    const extendTx = new Transaction().add(extendIx);
    await sendTx(ctx.connection, extendTx, [ctx.admin]);

    await sleep(ALT_WARMUP_SLEEP_MS);

    // Set market ALT
    const setAltIx = buildSetMarketAltIx({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      market,
      altAddress: altPubkey,
    });
    const setAltTx = new Transaction().add(setAltIx);
    await sendTx(ctx.connection, setAltTx, [ctx.admin]);

    altAddress = altPubkey;
  } catch (e: any) {
    console.log(`  WARNING: ALT creation failed for ${ticker}: ${e.message}`);
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

// ── Settlement helper ──────────────────────────────────────────────────────

async function settleDay(
  ctx: SharedContext,
  dayMarkets: MarketContext[],
  oracle: OracleSimulator,
  errors: ErrorEntry[],
): Promise<Map<string, "yes" | "no">> {
  const outcomes = new Map<string, "yes" | "no">();

  // Update all oracle prices (timestamp = now - 2)
  await oracle.updateAllPrices(ctx);

  for (let i = 0; i < dayMarkets.length; i++) {
    const m = dayMarkets[i];
    try {
      // Fresh oracle update per market
      await oracle.updateOraclePrice(ctx, m.ticker);

      const settleIx = buildSettleMarketIx({
        caller: ctx.admin.publicKey,
        config: ctx.configPda,
        market: m.market,
        oracleFeed: m.oracleFeed,
      });
      const tx = new Transaction().add(settleIx);
      await sendTx(ctx.connection, tx, [ctx.admin]);
      ctx.metrics.instructionTypes.add("settle_market");

      const state = await readMarketState(ctx.connection, m.market);
      if (state) {
        outcomes.set(m.market.toBase58(), state.outcome === 1 ? "yes" : "no");
      }
    } catch (e: any) {
      errors.push({
        timestamp: Date.now(),
        agentId: -1,
        instruction: "settle_market",
        market: m.ticker,
        message: e.message,
      });
    }
  }

  return outcomes;
}

// ── Crank cancel helper ────────────────────────────────────────────────────

async function crankCancelDay(
  ctx: SharedContext,
  dayMarkets: MarketContext[],
  errors: ErrorEntry[],
): Promise<void> {
  for (const m of dayMarkets) {
    try {
      const obAcct = await ctx.connection.getAccountInfo(m.orderBook);
      if (!obAcct) continue;

      const orders = parseOrderBook(Buffer.from(obAcct.data));
      if (orders.length === 0) continue;

      // Build remaining accounts per order (side-dependent ATA)
      const makerAccounts: PublicKey[] = [];
      for (const order of orders) {
        if (order.side === 0) {
          // USDC bid → return USDC
          makerAccounts.push(getAssociatedTokenAddressSync(ctx.usdcMint, order.owner));
        } else if (order.side === 1) {
          // Yes ask → return Yes tokens
          makerAccounts.push(getAssociatedTokenAddressSync(m.yesMint, order.owner));
        } else if (order.side === 2) {
          // No bid → return No tokens
          makerAccounts.push(getAssociatedTokenAddressSync(m.noMint, order.owner));
        }
      }

      // Batch crank_cancel
      const acctBatches = batch(makerAccounts, CRANK_CANCEL_BATCH_SIZE);
      for (const acctGroup of acctBatches) {
        const ix = buildCrankCancelIx({
          caller: ctx.admin.publicKey,
          config: ctx.configPda,
          market: m.market,
          orderBook: m.orderBook,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          batchSize: acctGroup.length,
          makerAccounts: acctGroup,
        });
        const tx = new Transaction().add(ix);
        await sendTx(ctx.connection, tx, [ctx.admin]);
        ctx.metrics.instructionTypes.add("crank_cancel");
      }
    } catch (e: any) {
      errors.push({
        timestamp: Date.now(),
        agentId: -1,
        instruction: "crank_cancel",
        market: m.ticker,
        message: e.message,
      });
    }
  }
}

// ── Crank redeem helper ────────────────────────────────────────────────────

async function crankRedeemDay(
  ctx: SharedContext,
  dayMarkets: MarketContext[],
  errors: ErrorEntry[],
): Promise<void> {
  for (const m of dayMarkets) {
    try {
      const state = await readMarketState(ctx.connection, m.market);
      if (!state || !state.isSettled) continue;

      const winningMint = state.outcome === 1 ? m.yesMint : m.noMint;

      // Find holders: agents who might have winning tokens
      const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
      let holderCount = 0;

      for (const agent of ctx.agents) {
        if (holderCount >= CRANK_REDEEM_MAX_USERS) break;
        try {
          const winAta = getAssociatedTokenAddressSync(winningMint, agent.keypair.publicKey);
          const acct = await getAccount(ctx.connection, winAta);
          if (acct.amount > 0n) {
            const usdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, agent.keypair.publicKey);
            remainingAccounts.push(
              { pubkey: winAta, isSigner: false, isWritable: true },
              { pubkey: usdcAta, isSigner: false, isWritable: true },
            );
            holderCount++;
          }
        } catch {
          // No ATA or empty — skip
        }
      }

      if (remainingAccounts.length === 0) continue;

      const ix = buildCrankRedeemIx(
        {
          caller: ctx.admin.publicKey,
          config: ctx.configPda,
          market: m.market,
          yesMint: m.yesMint,
          noMint: m.noMint,
          usdcVault: m.usdcVault,
        },
        holderCount,
        remainingAccounts,
      );
      const tx = new Transaction().add(ix);
      await sendTx(ctx.connection, tx, [ctx.admin]);
      ctx.metrics.instructionTypes.add("crank_redeem");
    } catch (e: any) {
      errors.push({
        timestamp: Date.now(),
        agentId: -1,
        instruction: "crank_redeem",
        market: m.ticker,
        message: e.message,
      });
    }
  }
}

// ── Close markets helper ───────────────────────────────────────────────────

async function closeDay(
  ctx: SharedContext,
  dayMarkets: MarketContext[],
  errors: ErrorEntry[],
): Promise<number> {
  let closed = 0;
  for (const m of dayMarkets) {
    try {
      const ix = buildCloseMarketIx({
        admin: ctx.admin.publicKey,
        config: ctx.configPda,
        market: m.market,
        orderBook: m.orderBook,
        usdcVault: m.usdcVault,
        escrowVault: m.escrowVault,
        yesEscrow: m.yesEscrow,
        noEscrow: m.noEscrow,
        yesMint: m.yesMint,
        noMint: m.noMint,
        treasury: ctx.treasury,
      });
      const tx = new Transaction().add(ix);
      await sendTx(ctx.connection, tx, [ctx.admin]);
      ctx.metrics.instructionTypes.add("close_market");
      closed++;
    } catch (e: any) {
      errors.push({
        timestamp: Date.now(),
        agentId: -1,
        instruction: "close_market",
        market: m.ticker,
        message: e.message,
      });
    }
  }

  // Treasury redeem on first market (exercise the instruction)
  if (dayMarkets.length > 0 && ctx.agents.length > 0) {
    const m = dayMarkets[0];
    const agent = ctx.agents[0];
    try {
      const ix = buildTreasuryRedeemIx({
        user: agent.keypair.publicKey,
        config: ctx.configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        treasury: ctx.treasury,
        userUsdcAta: getAssociatedTokenAddressSync(ctx.usdcMint, agent.keypair.publicKey),
        userYesAta: getAssociatedTokenAddressSync(m.yesMint, agent.keypair.publicKey),
        userNoAta: getAssociatedTokenAddressSync(m.noMint, agent.keypair.publicKey),
      });
      const tx = new Transaction().add(ix);
      await sendTx(ctx.connection, tx, [agent.keypair]);
      ctx.metrics.instructionTypes.add("treasury_redeem");
    } catch {
      // May fail if no tokens to redeem — that's fine
    }
  }

  // Cleanup markets
  for (const m of dayMarkets) {
    try {
      const ix = buildCleanupMarketIx({
        admin: ctx.admin.publicKey,
        config: ctx.configPda,
        market: m.market,
        yesMint: m.yesMint,
        noMint: m.noMint,
      });
      const tx = new Transaction().add(ix);
      await sendTx(ctx.connection, tx, [ctx.admin]);
      ctx.metrics.instructionTypes.add("cleanup_market");
    } catch {
      // May fail if supply not zero — that's fine
    }
  }

  return closed;
}

// ── Main simulation ────────────────────────────────────────────────────────

export async function runAct3(ctx: SharedContext): Promise<ActResult> {
  const startMs = Date.now();
  const errors: ErrorEntry[] = [];
  const details: string[] = [];
  const dayResults: DayResult[] = [];

  // Build agent instances
  const agents: BaseAgent[] = ctx.agents.map((state) => {
    switch (state.type) {
      case "market-maker":
        return new MarketMaker(state, ctx);
      case "directional":
        return new Directional(state, ctx);
      case "scalper":
        return new Scalper(state, ctx);
      case "strike-creator":
        return new StrikeCreator(state, ctx);
    }
  });

  const oracle = new OracleSimulator(ctx.config.tickers, ctx.config.seed);
  const loopRng = new SeededRng(hashSeed(ctx.config.seed, "trading-loop"));
  const metricsCollector = new MetricsCollector();
  // Wire metrics collector data into ctx.metrics
  ctx.metrics = metricsCollector.data;

  let totalPlaced = 0;
  let totalFilled = 0;

  for (let day = 0; day < ctx.config.numDays; day++) {
    console.log(`\n  [Day ${day + 1}/${ctx.config.numDays}]`);

    // 1. Timing
    const now = Math.floor(Date.now() / 1000);
    const marketCloseUnix = now + (day + 1) * ctx.config.marketCloseOffsetSec;
    const tradingEndsMs = Date.now() + ctx.config.tradingWindowSec * 1000;

    // 2. Create markets
    console.log("    Creating markets...");
    const dayMarkets = await createDayMarkets(ctx, day, marketCloseUnix, oracle);
    details.push(`Day ${day + 1}: Created ${dayMarkets.length} markets`);

    // 3. Update oracle prices
    await oracle.updateAllPrices(ctx);

    // 4. Seed liquidity (market makers mint + post)
    console.log("    Seeding liquidity...");
    const mmAgents = agents.filter((a) => a.state.type === "market-maker");
    for (const mm of mmAgents) {
      await mm.act(dayMarkets, oracle.getAllPrices());
    }

    // 5. Trading loop
    console.log("    Trading...");
    let tpsFlush = Date.now() + 1000;
    const ordersBeforeTrading = ctx.agents.reduce((s, a) => s + a.ordersPlaced, 0);

    while (Date.now() < tradingEndsMs) {
      // Pick random agent (seeded for determinism) — only pass current day's markets
      const agentIdx = Math.floor(loopRng.next() * agents.length);
      await agents[agentIdx].act(dayMarkets, oracle.getAllPrices());

      // Periodically step oracle prices
      if (loopRng.next() < 0.05) {
        for (const ticker of ctx.config.tickers) {
          oracle.stepPrice(ticker);
        }
        await oracle.updateAllPrices(ctx);
      }

      // TPS flush
      if (Date.now() >= tpsFlush) {
        metricsCollector.flushTpsWindow();
        tpsFlush += 1000;
      }
    }

    const ordersAfterTrading = ctx.agents.reduce((s, a) => s + a.ordersPlaced, 0);
    const dayOrdersPlaced = ordersAfterTrading - ordersBeforeTrading;
    details.push(`Day ${day + 1}: ${dayOrdersPlaced} orders placed during trading`);

    // 6. Wait for market close
    const waitCloseMs = (marketCloseUnix * 1000) - Date.now() + 2000;
    if (waitCloseMs > 0 && waitCloseMs < 300_000) {
      console.log(`    Waiting ${Math.ceil(waitCloseMs / 1000)}s for market close...`);
      await sleep(waitCloseMs);
    }

    // 7. Settle
    console.log("    Settling markets...");
    const outcomes = await settleDay(ctx, dayMarkets, oracle, errors);

    // 8. Wait for override window
    if (dayMarkets.length > 0) {
      const state = await readMarketState(ctx.connection, dayMarkets[0].market);
      if (state) {
        const waitSec = Number(state.overrideDeadline) - Math.floor(Date.now() / 1000) + 1;
        if (waitSec > 0 && waitSec <= 30) {
          console.log(`    Waiting ${waitSec}s for override window...`);
          await sleep(waitSec * 1000);
        }
      }
    }

    // 9. Crank cancel
    console.log("    Cranking cancels...");
    await crankCancelDay(ctx, dayMarkets, errors);

    // 10. Crank redeem
    console.log("    Cranking redeems...");
    await crankRedeemDay(ctx, dayMarkets, errors);

    // 11. Close markets
    console.log("    Closing markets...");
    const closedCount = await closeDay(ctx, dayMarkets, errors);

    // 12. Build day result
    const dayFilled = ctx.agents.reduce((s, a) => s + a.ordersFilled, 0) - totalFilled;
    const dayResult: DayResult = {
      day,
      marketsCreated: dayMarkets.length,
      marketsSettled: outcomes.size,
      marketsClosed: closedCount,
      tokensMinted: 0n, // TODO: read from market state
      tokensRedeemed: 0n,
      ordersPlaced: dayOrdersPlaced,
      ordersFilled: dayFilled,
      mergeCount: metricsCollector.data.mergeCount,
      escrowReturned: 0n,
      vaultViolations: 0,
      settlementOutcomes: outcomes,
    };

    // 13. Verify day end
    console.log("    Verifying...");
    const verification = await verifyDayEnd(ctx, day, dayResult);
    if (!verification.passed) {
      for (const v of verification.violations) {
        errors.push({
          timestamp: Date.now(),
          agentId: -1,
          instruction: "verification",
          message: v,
        });
      }
      dayResult.vaultViolations = verification.violations.length;
    }

    dayResults.push(dayResult);
    totalPlaced += dayOrdersPlaced;
    totalFilled += dayFilled;

    // 14. Advance oracle for next day
    for (const ticker of ctx.config.tickers) {
      oracle.stepPrice(ticker);
    }

    console.log(
      `    Day ${day + 1} complete: ${dayMarkets.length} markets, ${dayOrdersPlaced} orders, ` +
      `${outcomes.size} settled, ${closedCount} closed`,
    );
  }

  // Cross-day verification
  if (dayResults.length > 1) {
    console.log("\n  Cross-day verification...");
    const crossVerification = await verifyCrossDay(ctx, dayResults);
    if (!crossVerification.passed) {
      for (const v of crossVerification.violations) {
        errors.push({
          timestamp: Date.now(),
          agentId: -1,
          instruction: "cross-day-verification",
          message: v,
        });
      }
    }
    if (crossVerification.warnings.length > 0) {
      details.push(`Cross-day warnings: ${crossVerification.warnings.join("; ")}`);
    }
  }

  metricsCollector.finalize(totalPlaced, totalFilled);

  const passed = errors.filter((e) => e.instruction === "verification").length === 0;

  return {
    name: "Act 3: Simulation",
    passed,
    duration: Date.now() - startMs,
    details,
    errors,
  };
}
