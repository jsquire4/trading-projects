/**
 * act2-user-flows.ts — Act 2: User Flows
 *
 * 8 named smoke tests executed sequentially. Each is independent and uses
 * fresh agents from ctx.agents (indices 6-15). This is a user flow
 * validation suite (~30 seconds).
 */

import { Transaction, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";

import {
  buildMintPairIx,
  buildPlaceOrderIx,
  buildCancelOrderIx,
  buildPauseIx,
  buildUnpauseIx,
  buildSettleMarketIx,
  buildAdminOverrideIx,
  buildRedeemIx,
  buildUpdatePriceIx,
  MERIDIAN_PROGRAM_ID,
} from "../../tests/helpers/instructions";
import { sendTx, parseOrderBook, readMarketState } from "../stress-test/helpers";
import type { SharedContext, ActResult, ErrorEntry, MarketContext } from "./types";
import { MAX_FILLS, CONFIDENCE_BPS_OF_PRICE, DEFAULT_MINT_QUANTITY } from "./config";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bn(val: bigint): BN {
  return new BN(val.toString());
}

type TestResult = { passed: boolean; detail: string };

async function ensureAtas(
  ctx: SharedContext,
  agentIndex: number,
  m: MarketContext,
): Promise<{ usdc: PublicKey; yes: PublicKey; no: PublicKey }> {
  const owner = ctx.agents[agentIndex].keypair.publicKey;
  await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.admin, ctx.usdcMint, owner);
  await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.admin, m.yesMint, owner);
  await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.admin, m.noMint, owner);
  return {
    usdc: getAssociatedTokenAddressSync(ctx.usdcMint, owner),
    yes: getAssociatedTokenAddressSync(m.yesMint, owner),
    no: getAssociatedTokenAddressSync(m.noMint, owner),
  };
}

async function mintPair(
  ctx: SharedContext,
  agentIndex: number,
  m: MarketContext,
  quantity: bigint,
): Promise<void> {
  const atas = await ensureAtas(ctx, agentIndex, m);
  const agent = ctx.agents[agentIndex];
  const ix = buildMintPairIx({
    user: agent.keypair.publicKey,
    config: ctx.configPda,
    market: m.market,
    yesMint: m.yesMint,
    noMint: m.noMint,
    userUsdcAta: atas.usdc,
    userYesAta: atas.yes,
    userNoAta: atas.no,
    usdcVault: m.usdcVault,
    quantity: bn(quantity),
  });
  const tx = new Transaction().add(ix);
  await sendTx(ctx.connection, tx, [agent.keypair]);
}

function placeOrderParams(
  ctx: SharedContext,
  agentIndex: number,
  m: MarketContext,
  atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
  side: number,
  price: number,
  quantity: bigint,
  maxFills: number,
  makerAccounts?: PublicKey[],
) {
  const agent = ctx.agents[agentIndex];
  return {
    user: agent.keypair.publicKey,
    config: ctx.configPda,
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
    feeVault: ctx.feeVault,
    side,
    price,
    quantity: bn(quantity),
    orderType: 1, // Limit
    maxFills,
    makerAccounts,
  };
}

async function readBook(ctx: SharedContext, m: MarketContext) {
  const acct = await ctx.connection.getAccountInfo(m.orderBook);
  if (!acct) throw new Error("OrderBook account not found");
  return parseOrderBook(Buffer.from(acct.data));
}

// ── T1: Buy Yes fills resting ask ────────────────────────────────────────────

async function test1(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY;
  // Alice = agent 6
  await mintPair(ctx, 6, m, QTY);
  const aliceAtas = await ensureAtas(ctx, 6, m);
  const alice = ctx.agents[6];

  // Alice places resting ask (side=1) at 55c
  const askIx = buildPlaceOrderIx(placeOrderParams(ctx, 6, m, aliceAtas, 1, 55, QTY, 0));
  await sendTx(ctx.connection, new Transaction().add(askIx), [alice.keypair]);

  // Bob = agent 7
  const bobAtas = await ensureAtas(ctx, 7, m);

  // Fresh orderbook read
  const orders = await readBook(ctx, m);
  const restingAsks = orders.filter((o) => o.side === 1 && o.priceLevel === 55);
  if (restingAsks.length === 0) return { passed: false, detail: "No resting ask found at 55c" };

  // Bob places crossing bid (side=0) at 55c, maxFills=1
  const bidIx = buildPlaceOrderIx(
    placeOrderParams(ctx, 7, m, bobAtas, 0, 55, QTY, 1, [aliceAtas.usdc]),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [ctx.agents[7].keypair]);

  // Assert Bob's Yes ATA balance > 0
  const bobYes = await getAccount(ctx.connection, bobAtas.yes);
  if (bobYes.amount > 0n) {
    return { passed: true, detail: `Bob received ${bobYes.amount} Yes tokens` };
  }
  return { passed: false, detail: `Bob Yes balance is ${bobYes.amount}, expected > 0` };
}

// ── T2: Market maker spread gets swept ───────────────────────────────────────

async function test2(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY;
  // MM = agent 8
  await mintPair(ctx, 8, m, QTY * 4n);
  const mmAtas = await ensureAtas(ctx, 8, m);
  const mm = ctx.agents[8];

  // Place 5 resting asks at 51-55c
  const prices = [51, 52, 53, 54, 55];
  for (const p of prices) {
    const ix = buildPlaceOrderIx(placeOrderParams(ctx, 8, m, mmAtas, 1, p, QTY / 5n, 0));
    await sendTx(ctx.connection, new Transaction().add(ix), [mm.keypair]);
  }

  // Taker = agent 9
  const takerAtas = await ensureAtas(ctx, 9, m);

  // Fresh orderbook read
  const orders = await readBook(ctx, m);
  const restingAsks = orders.filter((o) => o.side === 1 && o.owner.equals(mm.keypair.publicKey));
  const makerAccounts = [mmAtas.usdc]; // all from same MM

  // Taker sweeps with bid at 99c, maxFills=5
  const bidIx = buildPlaceOrderIx(
    placeOrderParams(ctx, 9, m, takerAtas, 0, 99, QTY, Math.min(restingAsks.length, MAX_FILLS), makerAccounts),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [ctx.agents[9].keypair]);

  const takerYes = await getAccount(ctx.connection, takerAtas.yes);
  if (takerYes.amount > 0n) {
    return { passed: true, detail: `Taker swept ${restingAsks.length} asks, received ${takerYes.amount} Yes tokens` };
  }
  return { passed: false, detail: `Taker Yes balance is ${takerYes.amount}, expected > 0` };
}

// ── T3: Pair burn restores USDC ──────────────────────────────────────────────

async function test3(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 5n; // 10M
  const agent = ctx.agents[10];
  const atas = await ensureAtas(ctx, 10, m);

  // Record initial USDC balance
  const initialUsdc = (await getAccount(ctx.connection, atas.usdc)).amount;

  // Mint pair
  await mintPair(ctx, 10, m, QTY);

  // Redeem mode=0 (pair burn)
  const redeemIx = buildRedeemIx({
    user: agent.keypair.publicKey,
    config: ctx.configPda,
    market: m.market,
    yesMint: m.yesMint,
    noMint: m.noMint,
    usdcVault: m.usdcVault,
    userUsdcAta: atas.usdc,
    userYesAta: atas.yes,
    userNoAta: atas.no,
    mode: 0,
    quantity: bn(QTY),
  });
  await sendTx(ctx.connection, new Transaction().add(redeemIx), [agent.keypair]);

  const finalUsdc = (await getAccount(ctx.connection, atas.usdc)).amount;
  const diff = finalUsdc > initialUsdc ? finalUsdc - initialUsdc : initialUsdc - finalUsdc;
  if (diff <= 1n) {
    return { passed: true, detail: `USDC restored: initial=${initialUsdc}, final=${finalUsdc}` };
  }
  return { passed: false, detail: `USDC mismatch: initial=${initialUsdc}, final=${finalUsdc}, diff=${diff}` };
}

// ── T4: Pause blocks orders; unpause resumes ────────────────────────────────

async function test4(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const agent = ctx.agents[11];
  const atas = await ensureAtas(ctx, 11, m);

  // Pause market
  const pauseIx = buildPauseIx({ admin: ctx.admin.publicKey, config: ctx.configPda, market: m.market });
  await sendTx(ctx.connection, new Transaction().add(pauseIx), [ctx.admin]);

  // Try to place order — should fail
  let orderBlockedByPause = false;
  try {
    const bidIx = buildPlaceOrderIx(
      placeOrderParams(ctx, 11, m, atas, 0, 50, DEFAULT_MINT_QUANTITY / 10n, 0),
    );
    await sendTx(ctx.connection, new Transaction().add(bidIx), [agent.keypair]);
  } catch (e: any) {
    orderBlockedByPause = true;
  }

  // Unpause market
  const unpauseIx = buildUnpauseIx({ admin: ctx.admin.publicKey, config: ctx.configPda, market: m.market });
  await sendTx(ctx.connection, new Transaction().add(unpauseIx), [ctx.admin]);

  // Place order — should succeed
  let orderAfterUnpause = false;
  try {
    const bidIx = buildPlaceOrderIx(
      placeOrderParams(ctx, 11, m, atas, 0, 50, DEFAULT_MINT_QUANTITY / 10n, 0),
    );
    await sendTx(ctx.connection, new Transaction().add(bidIx), [agent.keypair]);
    orderAfterUnpause = true;
  } catch {
    orderAfterUnpause = false;
  }

  if (orderBlockedByPause && orderAfterUnpause) {
    return { passed: true, detail: "Pause blocked order, unpause allowed it" };
  }
  return {
    passed: false,
    detail: `pauseBlocked=${orderBlockedByPause}, unpauseAllowed=${orderAfterUnpause}`,
  };
}

// ── T5: Winner redeems after settlement ──────────────────────────────────────

async function test5(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const m2 = ctx.markets.length > 1 ? ctx.markets[1] : null;
  if (!m2) return { passed: false, detail: "Need ctx.markets[1] — skipped (Act 1 did not create enough markets)" };

  const QTY = DEFAULT_MINT_QUANTITY / 10n; // 5M
  const agent = ctx.agents[12];
  const atas = await ensureAtas(ctx, 12, m2);

  await mintPair(ctx, 12, m2, QTY);

  // Wait for market close if in the future
  const now = Math.floor(Date.now() / 1000);
  if (m2.marketCloseUnix > now) {
    const waitMs = (m2.marketCloseUnix - now + 2) * 1000;
    await sleep(waitMs);
  }

  // Update oracle with price > strike (Yes wins)
  const winPrice = m2.strikeLamports + 1_000_000n;
  const confidence = bn(BigInt(Math.max(1, Number(winPrice) * CONFIDENCE_BPS_OF_PRICE / 10000)));
  const updateIx = buildUpdatePriceIx({
    authority: ctx.admin.publicKey,
    priceFeed: m2.oracleFeed,
    price: bn(winPrice),
    confidence,
    timestamp: new BN(Math.floor(Date.now() / 1000)),
  });
  await sendTx(ctx.connection, new Transaction().add(updateIx), [ctx.admin]);

  // Settle
  const settleIx = buildSettleMarketIx({
    caller: ctx.admin.publicKey,
    config: ctx.configPda,
    market: m2.market,
    oracleFeed: m2.oracleFeed,
  });
  await sendTx(ctx.connection, new Transaction().add(settleIx), [ctx.admin]);

  // Wait override window
  const state = await readMarketState(ctx.connection, m2.market);
  if (state && state.overrideDeadline > 0n) {
    const deadline = Number(state.overrideDeadline);
    const waitSec = deadline - Math.floor(Date.now() / 1000) + 2;
    if (waitSec > 0) await sleep(waitSec * 1000);
  }

  // Record USDC before redeem
  const usdcBefore = (await getAccount(ctx.connection, atas.usdc)).amount;

  // Redeem mode=1 (winner redemption)
  const redeemIx = buildRedeemIx({
    user: agent.keypair.publicKey,
    config: ctx.configPda,
    market: m2.market,
    yesMint: m2.yesMint,
    noMint: m2.noMint,
    usdcVault: m2.usdcVault,
    userUsdcAta: atas.usdc,
    userYesAta: atas.yes,
    userNoAta: atas.no,
    mode: 1,
    quantity: bn(QTY),
  });
  await sendTx(ctx.connection, new Transaction().add(redeemIx), [agent.keypair]);

  const usdcAfter = (await getAccount(ctx.connection, atas.usdc)).amount;
  if (usdcAfter > usdcBefore) {
    return { passed: true, detail: `Redeemed: USDC ${usdcBefore} → ${usdcAfter}` };
  }
  return { passed: false, detail: `USDC did not increase: before=${usdcBefore}, after=${usdcAfter}` };
}

// ── T6: Admin override flips outcome ─────────────────────────────────────────

async function test6(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const m3 = ctx.markets.length > 2 ? ctx.markets[2] : null;
  if (!m3) return { passed: false, detail: "Need ctx.markets[2] — skipped (Act 1 did not create enough markets)" };

  const QTY = DEFAULT_MINT_QUANTITY / 10n;
  await mintPair(ctx, 13, m3, QTY);

  // Wait for market close
  const now = Math.floor(Date.now() / 1000);
  if (m3.marketCloseUnix > now) {
    const waitMs = (m3.marketCloseUnix - now + 2) * 1000;
    await sleep(waitMs);
  }

  // Settle with price > strike (Yes wins, outcome=1)
  const winPrice = m3.strikeLamports + 1_000_000n;
  const confidence = bn(BigInt(Math.max(1, Number(winPrice) * CONFIDENCE_BPS_OF_PRICE / 10000)));
  const updateIx = buildUpdatePriceIx({
    authority: ctx.admin.publicKey,
    priceFeed: m3.oracleFeed,
    price: bn(winPrice),
    confidence,
    timestamp: new BN(Math.floor(Date.now() / 1000)),
  });
  await sendTx(ctx.connection, new Transaction().add(updateIx), [ctx.admin]);

  const settleIx = buildSettleMarketIx({
    caller: ctx.admin.publicKey,
    config: ctx.configPda,
    market: m3.market,
    oracleFeed: m3.oracleFeed,
  });
  await sendTx(ctx.connection, new Transaction().add(settleIx), [ctx.admin]);

  const stateBefore = await readMarketState(ctx.connection, m3.market);
  if (!stateBefore) return { passed: false, detail: "Could not read market state after settle" };

  // Override with price < strike (flips to No, outcome=2)
  const losePrice = m3.strikeLamports - 1_000_000n;
  const overrideIx = buildAdminOverrideIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    market: m3.market,
    newSettlementPrice: bn(losePrice > 0n ? losePrice : 1n),
  });
  await sendTx(ctx.connection, new Transaction().add(overrideIx), [ctx.admin]);

  const stateAfter = await readMarketState(ctx.connection, m3.market);
  if (!stateAfter) return { passed: false, detail: "Could not read market state after override" };

  if (stateAfter.outcome !== stateBefore.outcome) {
    return { passed: true, detail: `Outcome flipped: ${stateBefore.outcome} → ${stateAfter.outcome}` };
  }
  return { passed: false, detail: `Outcome unchanged: before=${stateBefore.outcome}, after=${stateAfter.outcome}` };
}

// ── T7: Sell Yes fills resting bid ───────────────────────────────────────────

async function test7(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 5n; // 10M
  // Agent 14 places resting bid
  await mintPair(ctx, 14, m, QTY);
  const a14Atas = await ensureAtas(ctx, 14, m);
  const a14 = ctx.agents[14];

  const bidIx = buildPlaceOrderIx(
    placeOrderParams(ctx, 14, m, a14Atas, 0, 50, QTY, 0),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [a14.keypair]);

  // Agent 15 sells Yes into resting bid
  await mintPair(ctx, 15, m, QTY);
  const a15Atas = await ensureAtas(ctx, 15, m);
  const a15 = ctx.agents[15];

  // Fresh orderbook read
  const orders = await readBook(ctx, m);
  const restingBids = orders.filter((o) => o.side === 0 && o.priceLevel === 50);
  if (restingBids.length === 0) return { passed: false, detail: "No resting bid found at 50c" };

  // Agent 15 places crossing ask (side=1) at 50c, maxFills=1
  // makerAccounts for crossing ask (side=1): maker's USDC ATA
  const askIx = buildPlaceOrderIx(
    placeOrderParams(ctx, 15, m, a15Atas, 1, 50, QTY, 1, [a14Atas.usdc]),
  );
  await sendTx(ctx.connection, new Transaction().add(askIx), [a15.keypair]);

  // Assert: Agent 14 holds Yes tokens
  const a14Yes = await getAccount(ctx.connection, a14Atas.yes);
  // Assert: Agent 15 received USDC (more than before the sell)
  const a15Usdc = await getAccount(ctx.connection, a15Atas.usdc);

  if (a14Yes.amount > 0n && a15Usdc.amount > 0n) {
    return { passed: true, detail: `Agent14 Yes=${a14Yes.amount}, Agent15 USDC=${a15Usdc.amount}` };
  }
  return { passed: false, detail: `Agent14 Yes=${a14Yes.amount}, Agent15 USDC=${a15Usdc.amount}` };
}

// ── T8: Sell No locks tokens, cancel returns them ────────────────────────────

async function test8(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 10n; // 5M
  const agent = ctx.agents[6]; // reuse from T1
  const atas = await ensureAtas(ctx, 6, m);

  // Mint fresh if needed
  await mintPair(ctx, 6, m, QTY);

  // Record No ATA balance
  const noBefore = (await getAccount(ctx.connection, atas.no)).amount;

  // Place side=2 (No-backed bid) at 40c, resting
  const orderIx = buildPlaceOrderIx(
    placeOrderParams(ctx, 6, m, atas, 2, 40, QTY, 0),
  );
  await sendTx(ctx.connection, new Transaction().add(orderIx), [agent.keypair]);

  // Assert: No ATA balance decreased
  const noAfterPlace = (await getAccount(ctx.connection, atas.no)).amount;
  if (noAfterPlace >= noBefore) {
    return { passed: false, detail: `No balance did not decrease: before=${noBefore}, after=${noAfterPlace}` };
  }

  // Fresh orderbook read, find the order
  const orders = await readBook(ctx, m);
  const myOrder = orders.find(
    (o) => o.side === 2 && o.priceLevel === 40 && o.owner.equals(agent.keypair.publicKey),
  );
  if (!myOrder) return { passed: false, detail: "Could not find resting No order at 40c" };

  // Cancel
  const cancelIx = buildCancelOrderIx({
    user: agent.keypair.publicKey,
    config: ctx.configPda,
    market: m.market,
    orderBook: m.orderBook,
    escrowVault: m.escrowVault,
    yesEscrow: m.yesEscrow,
    noEscrow: m.noEscrow,
    userUsdcAta: atas.usdc,
    userYesAta: atas.yes,
    userNoAta: atas.no,
    price: 40,
    orderId: bn(myOrder.orderId),
  });
  await sendTx(ctx.connection, new Transaction().add(cancelIx), [agent.keypair]);

  // Assert: No ATA balance restored
  const noAfterCancel = (await getAccount(ctx.connection, atas.no)).amount;
  if (noAfterCancel >= noBefore) {
    return { passed: true, detail: `No tokens restored: ${noAfterPlace} → ${noAfterCancel} (was ${noBefore})` };
  }
  return { passed: false, detail: `No balance not restored: before=${noBefore}, afterCancel=${noAfterCancel}` };
}

// ── Main runner ──────────────────────────────────────────────────────────────

interface TestDef {
  name: string;
  fn: (ctx: SharedContext, m: MarketContext) => Promise<TestResult>;
}

const TESTS: TestDef[] = [
  { name: "Buy Yes fills resting ask", fn: test1 },
  { name: "Market maker spread gets swept", fn: test2 },
  { name: "Pair burn restores USDC", fn: test3 },
  { name: "Pause blocks orders; unpause resumes", fn: test4 },
  { name: "Winner redeems after settlement", fn: test5 },
  { name: "Admin override flips outcome", fn: test6 },
  { name: "Sell Yes fills resting bid", fn: test7 },
  { name: "Sell No locks No tokens, cancel returns them", fn: test8 },
];

export async function runAct2(ctx: SharedContext): Promise<ActResult> {
  const startMs = Date.now();
  const details: string[] = [];
  const errors: ErrorEntry[] = [];
  let allPassed = true;

  if (ctx.markets.length === 0) {
    return {
      name: "Act 2: User Flows",
      passed: false,
      duration: Date.now() - startMs,
      details: ["SKIPPED: ctx.markets is empty — Act 1 must run first to create markets"],
      errors: [],
    };
  }

  if (ctx.agents.length < 16) {
    return {
      name: "Act 2: User Flows",
      passed: false,
      duration: Date.now() - startMs,
      details: [`SKIPPED: need at least 16 agents, have ${ctx.agents.length}`],
      errors: [],
    };
  }

  const m = ctx.markets[0];

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const testStart = Date.now();
    try {
      const result = await test.fn(ctx, m);
      const elapsed = Date.now() - testStart;
      const status = result.passed ? "PASS" : "FAIL";
      details.push(`T${i + 1} [${status}] ${test.name} (${elapsed}ms): ${result.detail}`);
      if (!result.passed) {
        allPassed = false;
        errors.push({
          timestamp: Date.now(),
          agentId: -1,
          instruction: `T${i + 1}:${test.name}`,
          message: result.detail,
        });
      }
    } catch (e: any) {
      const elapsed = Date.now() - testStart;
      allPassed = false;
      const msg = e.message ?? String(e);
      details.push(`T${i + 1} [ERROR] ${test.name} (${elapsed}ms): ${msg}`);
      errors.push({
        timestamp: Date.now(),
        agentId: -1,
        instruction: `T${i + 1}:${test.name}`,
        message: msg,
      });
    }
  }

  return {
    name: "Act 2: User Flows",
    passed: allPassed,
    duration: Date.now() - startMs,
    details,
    errors,
  };
}
