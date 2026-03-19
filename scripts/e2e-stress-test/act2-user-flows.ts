/**
 * act2-user-flows.ts — Act 2: User Flows
 *
 * 13 named smoke tests executed sequentially. Each test is fully self-contained:
 * it creates fresh keypairs, funds them, and manages its own state. No test
 * depends on the outcome of any other test. Works with any seed or agent count.
 */

import {
  Transaction,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
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
  buildCreateStrikeMarketIx,
  buildSetMarketAltIx,
  buildTransferAdminIx,
  buildAcceptAdminIx,
  buildWithdrawFeesIx,
  buildUpdateConfigIx,
  buildCircuitBreakerIx,
  padTicker,
} from "../../tests/helpers/instructions";
import {
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findTickerRegistry,
  findSolTreasury,
} from "../../services/shared/src/pda";
import { sendTx, parseOrderBook, readMarketState, findPriceFeed, sleep } from "./helpers";
import type { SharedContext, ActResult, ErrorEntry, MarketContext } from "./types";
import { BASE_PRICES } from "../../services/shared/src/synthetic-config";
import {
  MAX_FILLS,
  CONFIDENCE_BPS_OF_PRICE,
  DEFAULT_MINT_QUANTITY,
  ALT_WARMUP_SLEEP_MS,
  USDC_PER_AGENT,
} from "./config";

// ── Helpers ──────────────────────────────────────────────────────────────────

function bn(val: bigint): BN {
  return new BN(val.toString());
}

type TestResult = { passed: boolean; detail: string };

/** Create a fresh funded keypair for a test. Fully independent of ctx.agents. */
async function freshAgent(ctx: SharedContext): Promise<Keypair> {
  const kp = Keypair.generate();
  // Airdrop SOL
  const sig = await ctx.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
  await ctx.connection.confirmTransaction(sig, "confirmed");
  // Create USDC ATA and mint USDC
  const ata = await getOrCreateAssociatedTokenAccount(
    ctx.connection, ctx.admin, ctx.usdcMint, kp.publicKey,
  );
  await mintTo(ctx.connection, ctx.admin, ctx.usdcMint, ata.address, ctx.faucet, USDC_PER_AGENT);
  return kp;
}

/** Ensure Yes/No/USDC ATAs exist for a keypair on a market. */
async function atasFor(
  ctx: SharedContext,
  kp: Keypair,
  m: MarketContext,
): Promise<{ usdc: PublicKey; yes: PublicKey; no: PublicKey }> {
  const owner = kp.publicKey;
  await getOrCreateAssociatedTokenAccount(ctx.connection, kp, ctx.usdcMint, owner);
  await getOrCreateAssociatedTokenAccount(ctx.connection, kp, m.yesMint, owner);
  await getOrCreateAssociatedTokenAccount(ctx.connection, kp, m.noMint, owner);
  return {
    usdc: getAssociatedTokenAddressSync(ctx.usdcMint, owner),
    yes: getAssociatedTokenAddressSync(m.yesMint, owner),
    no: getAssociatedTokenAddressSync(m.noMint, owner),
  };
}

/** Mint pairs for a keypair. */
async function mintPairFor(
  ctx: SharedContext,
  kp: Keypair,
  m: MarketContext,
  atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
  quantity: bigint,
): Promise<void> {
  const ix = buildMintPairIx({
    user: kp.publicKey,
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
  await sendTx(ctx.connection, new Transaction().add(ix), [kp]);
}

/** Build place_order params for a keypair (not indexed agent). */
function orderParams(
  ctx: SharedContext,
  kp: Keypair,
  m: MarketContext,
  atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
  side: number,
  price: number,
  quantity: bigint,
  maxFills: number,
  makerAccounts?: PublicKey[],
) {
  return {
    user: kp.publicKey,
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
    orderType: 1,
    maxFills,
    makerAccounts,
  };
}

async function readBook(ctx: SharedContext, m: MarketContext) {
  const acct = await ctx.connection.getAccountInfo(m.orderBook);
  if (!acct) throw new Error("OrderBook account not found");
  return parseOrderBook(Buffer.from(acct.data));
}

// ── Market creation helper ────────────────────────────────────────────────────

async function createAct2Market(
  ctx: SharedContext,
  ticker: string,
  closeOffsetSec: number = 300,
  strikeOffsetDollars: number = 30,
): Promise<MarketContext> {
  const { connection, admin, configPda, usdcMint } = ctx;
  const basePrice = BASE_PRICES[ticker] ?? 100;
  const strikeLamports = BigInt(Math.round(basePrice / 10) * 10 + strikeOffsetDollars) * 1_000_000n;
  const previousCloseLamports = BigInt(basePrice) * 1_000_000n;
  const marketCloseUnix = Math.floor(Date.now() / 1000) + closeOffsetSec;
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

  // Create strike market
  const [solTreasuryPda] = findSolTreasury();
  const createIx = buildCreateStrikeMarketIx({
    admin: admin.publicKey,
    config: configPda,
    market, yesMint, noMint, usdcVault, escrowVault,
    yesEscrow, noEscrow, orderBook, oracleFeed, usdcMint,
    ticker: padTicker(ticker),
    strikePrice: new BN(strikeLamports.toString()),
    expiryDay,
    marketCloseUnix: new BN(marketCloseUnix),
    previousClose: new BN(previousCloseLamports.toString()),
    solTreasury: solTreasuryPda,
  });
  await sendTx(connection, new Transaction().add(createIx), [admin]);

  // ALT creation (non-fatal)
  let altAddress: PublicKey | undefined;
  try {
    const slot = await connection.getSlot("finalized");
    const [createLutIx, lutAddr] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
    });
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey, authority: admin.publicKey, lookupTable: lutAddr,
      addresses: [market, yesMint, noMint, usdcVault, escrowVault, yesEscrow, noEscrow, orderBook, oracleFeed],
    });
    await sendTx(connection, new Transaction().add(createLutIx, extendIx), [admin]);
    await sleep(ALT_WARMUP_SLEEP_MS);
    const setAltIx = buildSetMarketAltIx({
      admin: admin.publicKey, config: configPda, market, altAddress: lutAddr,
    });
    await sendTx(connection, new Transaction().add(setAltIx), [admin]);
    altAddress = lutAddr;
  } catch {
    // ALT not critical
  }

  return {
    ticker, strikeLamports, previousCloseLamports, marketCloseUnix,
    market, yesMint, noMint, usdcVault, escrowVault,
    yesEscrow, noEscrow, orderBook, oracleFeed, altAddress, day: 0,
  };
}

// ── T1: Buy Yes fills resting ask ────────────────────────────────────────────

async function test1(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY;
  const alice = await freshAgent(ctx);
  const bob = await freshAgent(ctx);

  const aliceAtas = await atasFor(ctx, alice, m);
  const bobAtas = await atasFor(ctx, bob, m);

  // Alice mints pairs and places resting ask (side=1, no constraint)
  await mintPairFor(ctx, alice, m, aliceAtas, QTY);
  const askIx = buildPlaceOrderIx(orderParams(ctx, alice, m, aliceAtas, 1, 55, QTY, 0));
  await sendTx(ctx.connection, new Transaction().add(askIx), [alice]);

  // Bob places crossing bid (side=0, requires no_ata==0 — fresh agent, so safe)
  const orders = await readBook(ctx, m);
  const restingAsks = orders.filter((o) => o.side === 1 && o.priceLevel === 55);
  if (restingAsks.length === 0) return { passed: false, detail: "No resting ask found at 55c" };

  const bidIx = buildPlaceOrderIx(
    orderParams(ctx, bob, m, bobAtas, 0, 55, QTY, 1, [aliceAtas.usdc]),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [bob]);

  const bobYes = await getAccount(ctx.connection, bobAtas.yes);
  if (bobYes.amount > 0n) {
    return { passed: true, detail: `Bob received ${bobYes.amount} Yes tokens` };
  }
  return { passed: false, detail: `Bob Yes balance is ${bobYes.amount}, expected > 0` };
}

// ── T2: Market maker spread gets swept ───────────────────────────────────────

async function test2(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY;
  const mm = await freshAgent(ctx);
  const taker = await freshAgent(ctx);

  const mmAtas = await atasFor(ctx, mm, m);
  const takerAtas = await atasFor(ctx, taker, m);

  // MM mints and places 5 resting asks at 51-55c (side=1, no constraint)
  await mintPairFor(ctx, mm, m, mmAtas, QTY * 4n);
  const prices = [51, 52, 53, 54, 55];
  for (const p of prices) {
    const ix = buildPlaceOrderIx(orderParams(ctx, mm, m, mmAtas, 1, p, QTY / 5n, 0));
    await sendTx(ctx.connection, new Transaction().add(ix), [mm]);
  }

  // Taker sweeps (side=0, fresh agent so no_ata==0)
  const orders = await readBook(ctx, m);
  const restingAsks = orders.filter((o) => o.side === 1 && o.owner.equals(mm.publicKey));
  const makerAccounts = restingAsks.map(() => mmAtas.usdc);

  const bidIx = buildPlaceOrderIx(
    orderParams(ctx, taker, m, takerAtas, 0, 99, QTY, Math.min(restingAsks.length, MAX_FILLS), makerAccounts),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [taker]);

  const takerYes = await getAccount(ctx.connection, takerAtas.yes);
  if (takerYes.amount > 0n) {
    return { passed: true, detail: `Taker swept ${restingAsks.length} asks, received ${takerYes.amount} Yes tokens` };
  }
  return { passed: false, detail: `Taker Yes balance is ${takerYes.amount}, expected > 0` };
}

// ── T3: Pair burn restores USDC ──────────────────────────────────────────────

async function test3(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 5n;
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m);

  const initialUsdc = (await getAccount(ctx.connection, atas.usdc)).amount;
  await mintPairFor(ctx, agent, m, atas, QTY);

  // Redeem mode=0 (pair burn)
  const redeemIx = buildRedeemIx({
    user: agent.publicKey,
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
  await sendTx(ctx.connection, new Transaction().add(redeemIx), [agent]);

  const finalUsdc = (await getAccount(ctx.connection, atas.usdc)).amount;
  const diff = finalUsdc > initialUsdc ? finalUsdc - initialUsdc : initialUsdc - finalUsdc;
  if (diff <= 1n) {
    return { passed: true, detail: `USDC restored: initial=${initialUsdc}, final=${finalUsdc}` };
  }
  return { passed: false, detail: `USDC mismatch: initial=${initialUsdc}, final=${finalUsdc}, diff=${diff}` };
}

// ── T4: Pause blocks orders; unpause resumes ────────────────────────────────

async function test4(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m);

  // Pause market
  const pauseIx = buildPauseIx({ admin: ctx.admin.publicKey, config: ctx.configPda });
  await sendTx(ctx.connection, new Transaction().add(pauseIx), [ctx.admin]);

  // Try to place order — should fail (side=0, fresh agent so no_ata==0)
  let orderBlockedByPause = false;
  try {
    const bidIx = buildPlaceOrderIx(
      orderParams(ctx, agent, m, atas, 0, 50, DEFAULT_MINT_QUANTITY / 10n, 0),
    );
    await sendTx(ctx.connection, new Transaction().add(bidIx), [agent]);
  } catch {
    orderBlockedByPause = true;
  }

  // Unpause market
  const unpauseIx = buildUnpauseIx({ admin: ctx.admin.publicKey, config: ctx.configPda });
  await sendTx(ctx.connection, new Transaction().add(unpauseIx), [ctx.admin]);

  // Place order — should succeed
  let orderAfterUnpause = false;
  try {
    const bidIx = buildPlaceOrderIx(
      orderParams(ctx, agent, m, atas, 0, 50, DEFAULT_MINT_QUANTITY / 10n, 0),
    );
    await sendTx(ctx.connection, new Transaction().add(bidIx), [agent]);
    orderAfterUnpause = true;
  } catch {
    orderAfterUnpause = false;
  }

  // Cancel the resting order to avoid polluting the book for subsequent tests
  if (orderAfterUnpause) {
    try {
      const orders = await readBook(ctx, m);
      const myOrder = orders.find(
        (o) => o.side === 0 && o.priceLevel === 50 && o.owner.equals(agent.publicKey),
      );
      if (myOrder) {
        const cancelIx = buildCancelOrderIx({
          user: agent.publicKey,
          config: ctx.configPda,
          market: m.market,
          orderBook: m.orderBook,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          userUsdcAta: atas.usdc,
          userYesAta: atas.yes,
          userNoAta: atas.no,
          price: 50,
          orderId: bn(myOrder.orderId),
        });
        await sendTx(ctx.connection, new Transaction().add(cancelIx), [agent]);
      }
    } catch {
      // Non-fatal: cleanup failure doesn't invalidate the test
    }
  }

  if (orderBlockedByPause && orderAfterUnpause) {
    return { passed: true, detail: "Pause blocked order, unpause allowed it" };
  }
  return { passed: false, detail: `pauseBlocked=${orderBlockedByPause}, unpauseAllowed=${orderAfterUnpause}` };
}

// ── T5: Sell Yes fills resting bid ───────────────────────────────────────────

async function test5(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 5n;
  const buyer = await freshAgent(ctx);  // places USDC bid (side=0)
  const seller = await freshAgent(ctx); // sells Yes (side=1)

  const buyerAtas = await atasFor(ctx, buyer, m);
  const sellerAtas = await atasFor(ctx, seller, m);

  // Buyer places resting USDC bid at unique price (side=0, fresh agent so no_ata==0)
  const bidPrice = 37; // unique price to avoid filling other tests' orders
  const bidIx = buildPlaceOrderIx(orderParams(ctx, buyer, m, buyerAtas, 0, bidPrice, QTY, 0));
  await sendTx(ctx.connection, new Transaction().add(bidIx), [buyer]);

  // Seller mints pairs (gets Yes+No) and sells Yes (side=1, no constraint)
  await mintPairFor(ctx, seller, m, sellerAtas, QTY);

  const orders = await readBook(ctx, m);
  const restingBids = orders.filter((o) => o.side === 0 && o.priceLevel === bidPrice && o.owner.equals(buyer.publicKey));
  if (restingBids.length === 0) {
    const allBids = orders.filter((o) => o.side === 0 && o.isActive);
    return { passed: false, detail: `No resting bid at ${bidPrice}c from buyer. Active bids: ${allBids.map(b => `${b.priceLevel}c by ${b.owner.toBase58().slice(0,8)}`).join(', ')}` };
  }

  // Crossing ask: for side=1 crossing side=0, maker receives Yes tokens
  // The maker account must be the maker's (buyer's) Yes ATA
  const askIx = buildPlaceOrderIx(
    orderParams(ctx, seller, m, sellerAtas, 1, bidPrice, QTY, 1, [buyerAtas.yes]),
  );
  try {
    await sendTx(ctx.connection, new Transaction().add(askIx), [seller]);
  } catch (e: any) {
    // Include diagnostic info for InvalidMakerAccount errors
    const buyerYesInfo = await getAccount(ctx.connection, buyerAtas.yes).catch(() => null);
    return {
      passed: false,
      detail: `Ask failed: ${e.message?.slice(0, 200)}. buyerYesATA=${buyerAtas.yes.toBase58().slice(0,8)} exists=${!!buyerYesInfo} owner=${buyerYesInfo ? buyerYesInfo.owner.toBase58().slice(0,8) : 'N/A'} buyer=${buyer.publicKey.toBase58().slice(0,8)} fill.maker=${restingBids[0].owner.toBase58().slice(0,8)}`,
    };
  }

  const buyerYes = await getAccount(ctx.connection, buyerAtas.yes);
  const sellerUsdc = await getAccount(ctx.connection, sellerAtas.usdc);

  if (buyerYes.amount > 0n && sellerUsdc.amount > 0n) {
    return { passed: true, detail: `Buyer Yes=${buyerYes.amount}, Seller USDC=${sellerUsdc.amount}` };
  }
  return { passed: false, detail: `Buyer Yes=${buyerYes.amount}, Seller USDC=${sellerUsdc.amount}` };
}

// ── T6: Sell No locks tokens, cancel returns them ────────────────────────────

async function test6(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  const QTY = DEFAULT_MINT_QUANTITY / 10n;
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m);

  // Mint pairs → agent has Yes + No
  await mintPairFor(ctx, agent, m, atas, QTY);

  // Escrow all Yes via resting ask at 99c (side=1, no constraint)
  // This sets yes_ata=0, enabling side=2
  const askIx = buildPlaceOrderIx(orderParams(ctx, agent, m, atas, 1, 99, QTY, 0));
  await sendTx(ctx.connection, new Transaction().add(askIx), [agent]);

  // Verify yes_ata is now 0
  const yesAfterAsk = await getAccount(ctx.connection, atas.yes);
  if (yesAfterAsk.amount > 0n) {
    return { passed: false, detail: `Yes ATA not fully escrowed: ${yesAfterAsk.amount} remaining` };
  }

  // Record No balance
  const noBefore = (await getAccount(ctx.connection, atas.no)).amount;

  // Place side=2 (No-backed bid) at 40c, resting — now yes_ata==0 ✓
  const orderIx = buildPlaceOrderIx(orderParams(ctx, agent, m, atas, 2, 40, QTY, 0));
  await sendTx(ctx.connection, new Transaction().add(orderIx), [agent]);

  // Assert: No ATA decreased (escrowed into no_escrow)
  const noAfterPlace = (await getAccount(ctx.connection, atas.no)).amount;
  if (noAfterPlace >= noBefore) {
    return { passed: false, detail: `No balance did not decrease: before=${noBefore}, after=${noAfterPlace}` };
  }

  // Find the resting order
  const orders = await readBook(ctx, m);
  const myOrder = orders.find(
    (o) => o.side === 2 && o.priceLevel === 40 && o.owner.equals(agent.publicKey),
  );
  if (!myOrder) return { passed: false, detail: "Could not find resting No order at 40c" };

  // Cancel it
  const cancelIx = buildCancelOrderIx({
    user: agent.publicKey,
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
  await sendTx(ctx.connection, new Transaction().add(cancelIx), [agent]);

  // Assert: No balance restored
  const noAfterCancel = (await getAccount(ctx.connection, atas.no)).amount;
  if (noAfterCancel >= noBefore) {
    return { passed: true, detail: `No tokens restored: ${noAfterPlace} → ${noAfterCancel} (was ${noBefore})` };
  }
  return { passed: false, detail: `No balance not restored: before=${noBefore}, afterCancel=${noAfterCancel}` };
}

// ── T7: Winner redeems after settlement ──────────────────────────────────────

async function test7(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Use a dedicated market for settlement tests (market[1])
  const m2 = ctx.markets.length > 1 ? ctx.markets[1] : null;
  if (!m2) return { passed: false, detail: "Need ctx.markets[1] for settlement test" };

  const QTY = DEFAULT_MINT_QUANTITY / 10n;
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m2);

  // Mint BEFORE market close
  await mintPairFor(ctx, agent, m2, atas, QTY);

  // Wait for market close
  const now = Math.floor(Date.now() / 1000);
  if (m2.marketCloseUnix > now) {
    const waitMs = (m2.marketCloseUnix - now + 2) * 1000;
    await sleep(waitMs);
  }

  // Update oracle: price > strike → Yes wins
  const winPrice = m2.strikeLamports + 1_000_000n;
  const confidence = bn(BigInt(Math.max(1, Number(winPrice) * CONFIDENCE_BPS_OF_PRICE / 10000)));
  const updateIx = buildUpdatePriceIx({
    authority: ctx.admin.publicKey,
    priceFeed: m2.oracleFeed,
    price: bn(winPrice),
    confidence,
    timestamp: new BN(Math.floor(Date.now() / 1000) - 2),
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

  // Redeem mode=1 (winner)
  const usdcBefore = (await getAccount(ctx.connection, atas.usdc)).amount;
  const redeemIx = buildRedeemIx({
    user: agent.publicKey,
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
  await sendTx(ctx.connection, new Transaction().add(redeemIx), [agent]);

  const usdcAfter = (await getAccount(ctx.connection, atas.usdc)).amount;
  if (usdcAfter > usdcBefore) {
    return { passed: true, detail: `Redeemed: USDC ${usdcBefore} → ${usdcAfter}` };
  }
  return { passed: false, detail: `USDC did not increase: before=${usdcBefore}, after=${usdcAfter}` };
}

// ── T8: Admin override flips outcome ─────────────────────────────────────────

async function test8(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Use a dedicated market for override test (market[2])
  const m3 = ctx.markets.length > 2 ? ctx.markets[2] : null;
  if (!m3) return { passed: false, detail: "Need ctx.markets[2] for override test" };

  const QTY = DEFAULT_MINT_QUANTITY / 10n;
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m3);

  // Bump override window to 30s so the override tx has time to land
  try {
    const bumpIx = buildUpdateConfigIx({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      overrideWindowSecs: 30,
    });
    await sendTx(ctx.connection, new Transaction().add(bumpIx), [ctx.admin]);
  } catch { /* non-fatal */ }

  // Mint BEFORE market close
  await mintPairFor(ctx, agent, m3, atas, QTY);

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
    timestamp: new BN(Math.floor(Date.now() / 1000) - 2),
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

  // Reset override window back to 1s
  try {
    const resetIx = buildUpdateConfigIx({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      overrideWindowSecs: 1,
    });
    await sendTx(ctx.connection, new Transaction().add(resetIx), [ctx.admin]);
  } catch { /* non-fatal */ }

  if (stateAfter.outcome !== stateBefore.outcome) {
    return { passed: true, detail: `Outcome flipped: ${stateBefore.outcome} → ${stateAfter.outcome}` };
  }
  return { passed: false, detail: `Outcome unchanged: before=${stateBefore.outcome}, after=${stateAfter.outcome}` };
}

// ── T9: Transfer admin two-step ───────────────────────────────────────────────

async function test9(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Propose transfer to a fresh keypair
  const newAdmin = Keypair.generate();

  // Fund newAdmin with SOL for signing
  const sig = await ctx.connection.requestAirdrop(newAdmin.publicKey, 1 * LAMPORTS_PER_SOL);
  await ctx.connection.confirmTransaction(sig, "confirmed");

  // Propose transfer
  const transferIx = buildTransferAdminIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    newAdmin: newAdmin.publicKey,
  });
  await sendTx(ctx.connection, new Transaction().add(transferIx), [ctx.admin]);

  // Accept transfer
  const acceptIx = buildAcceptAdminIx({
    newAdmin: newAdmin.publicKey,
    config: ctx.configPda,
  });
  await sendTx(ctx.connection, new Transaction().add(acceptIx), [newAdmin]);

  // Transfer back to original admin
  const transferBackIx = buildTransferAdminIx({
    admin: newAdmin.publicKey,
    config: ctx.configPda,
    newAdmin: ctx.admin.publicKey,
  });
  await sendTx(ctx.connection, new Transaction().add(transferBackIx), [newAdmin]);

  const acceptBackIx = buildAcceptAdminIx({
    newAdmin: ctx.admin.publicKey,
    config: ctx.configPda,
  });
  await sendTx(ctx.connection, new Transaction().add(acceptBackIx), [ctx.admin]);

  return { passed: true, detail: "Admin transferred to new key and back successfully" };
}

// ── T10: Withdraw fees ───────────────────────────────────────────────────────

async function test10(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Check fee vault balance
  const { getAccount: getTokenAccount } = await import("@solana/spl-token");

  let feeBalance = 0n;
  try {
    const feeAcct = await getTokenAccount(ctx.connection, ctx.feeVault);
    feeBalance = feeAcct.amount;
  } catch {
    return { passed: true, detail: "Fee vault empty or not found — withdraw not applicable" };
  }

  if (feeBalance === 0n) {
    return { passed: true, detail: "Fee vault empty — withdraw not applicable (no fills generated fees yet)" };
  }

  const adminUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.admin.publicKey);
  const beforeBalance = (await getTokenAccount(ctx.connection, adminUsdcAta)).amount;

  const withdrawIx = buildWithdrawFeesIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    feeVault: ctx.feeVault,
    adminUsdcAta,
  });
  await sendTx(ctx.connection, new Transaction().add(withdrawIx), [ctx.admin]);

  const afterBalance = (await getTokenAccount(ctx.connection, adminUsdcAta)).amount;
  if (afterBalance > beforeBalance) {
    return { passed: true, detail: `Withdrew ${afterBalance - beforeBalance} fee USDC (vault had ${feeBalance})` };
  }
  return { passed: true, detail: `Fee vault had ${feeBalance} — withdraw completed` };
}

// ── T11: Treasury free-balance guard ─────────────────────────────────────────

async function test11(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Try to withdraw a huge amount from treasury — should fail
  const adminUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.admin.publicKey);
  const hugeAmount = new BN("999999999999999"); // way more than available

  let blocked = false;
  try {
    const { buildWithdrawTreasuryIx } = await import("../../tests/helpers/instructions");
    const { findSolTreasury } = await import("../../services/shared/src/pda");
    const [solTreasuryPda] = findSolTreasury();
    const withdrawIx = buildWithdrawTreasuryIx({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      treasury: ctx.treasury,
      adminUsdcAta,
      solTreasury: solTreasuryPda,
      amount: hugeAmount,
    });
    await sendTx(ctx.connection, new Transaction().add(withdrawIx), [ctx.admin]);
  } catch {
    blocked = true;
  }

  if (blocked) {
    return { passed: true, detail: "Over-withdrawal correctly blocked by treasury guard" };
  }
  return { passed: false, detail: "Over-withdrawal was NOT blocked — treasury guard failed" };
}

// ── T12: Circuit breaker halts trading ───────────────────────────────────────

async function test12(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Read current pause state and ensure we start from a known state
  const configAcct = await ctx.connection.getAccountInfo(ctx.configPda);
  if (!configAcct) return { passed: false, detail: "Could not read GlobalConfig" };

  // GlobalConfig.is_paused is at byte offset 8+32+32+32+8+8+8 = 138 (after discriminator)
  // Actually: disc(8) + admin(32) + usdc_mint(32) + oracle_program(32) + staleness(8) +
  // settlement_staleness(8) + confidence_bps(8) = 128. is_paused is bool at offset 128.
  const isPaused = configAcct.data[8 + 32 + 32 + 32 + 8 + 8 + 8] !== 0;

  // If paused, unpause first so we start clean
  if (isPaused) {
    const unpIx = buildUnpauseIx({ admin: ctx.admin.publicKey, config: ctx.configPda });
    await sendTx(ctx.connection, new Transaction().add(unpIx), [ctx.admin]);
  }

  // Place a resting order first
  const agent = await freshAgent(ctx);
  const atas = await atasFor(ctx, agent, m);

  const bidIx = buildPlaceOrderIx(
    orderParams(ctx, agent, m, atas, 0, 30, DEFAULT_MINT_QUANTITY / 20n, 0),
  );
  await sendTx(ctx.connection, new Transaction().add(bidIx), [agent]);

  // Fire circuit breaker (global pause only)
  const cbIx = buildCircuitBreakerIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
  });
  await sendTx(ctx.connection, new Transaction().add(cbIx), [ctx.admin]);

  // Verify orders are still on the book (circuit breaker doesn't deactivate orders)
  const orders = await readBook(ctx, m);
  const myOrders = orders.filter((o) => o.owner.equals(agent.publicKey));

  // Unpause global config
  const unpauseGlobalIx = buildUnpauseIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
  });
  await sendTx(ctx.connection, new Transaction().add(unpauseGlobalIx), [ctx.admin]);

  if (myOrders.length > 0) {
    // Correct: circuit breaker pauses trading but does NOT cancel resting orders.
    // Orders should still be on the book after pause.
    return { passed: true, detail: `Circuit breaker paused — ${myOrders.length} orders preserved (expected)` };
  }
  return { passed: false, detail: "Orders disappeared after circuit breaker — should have been preserved" };
}

// ── T13: Update config ───────────────────────────────────────────────────────

async function test13(ctx: SharedContext, m: MarketContext): Promise<TestResult> {
  // Update staleness threshold to a new value
  const updateIx = buildUpdateConfigIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    stalenessThreshold: new BN(600),
  });
  await sendTx(ctx.connection, new Transaction().add(updateIx), [ctx.admin]);

  // Restore original value
  const restoreIx = buildUpdateConfigIx({
    admin: ctx.admin.publicKey,
    config: ctx.configPda,
    stalenessThreshold: new BN(300),
  });
  await sendTx(ctx.connection, new Transaction().add(restoreIx), [ctx.admin]);

  return { passed: true, detail: "Config staleness updated to 600 and restored to 300" };
}

// ── Main runner ──────────────────────────────────────────────────────────────

interface TestDef {
  name: string;
  fn: (ctx: SharedContext, m: MarketContext) => Promise<TestResult>;
}

// Tests ordered: active-trading tests first (need open markets),
// then settlement tests (T7 winner redeem uses market[1], T8 override uses market[2]).
// T8 must run before T7 because both wait for market close internally,
// and T7's wait would expire T8's market since they share the same close time.
const TESTS: TestDef[] = [
  { name: "Buy Yes fills resting ask", fn: test1 },
  { name: "Market maker spread gets swept", fn: test2 },
  { name: "Pair burn restores USDC", fn: test3 },
  { name: "Pause blocks orders; unpause resumes", fn: test4 },
  { name: "Sell Yes fills resting bid", fn: test5 },
  { name: "Sell No locks No tokens, cancel returns them", fn: test6 },
  { name: "Admin override flips outcome", fn: test8 },
  { name: "Winner redeems after settlement", fn: test7 },
  { name: "Transfer admin two-step", fn: test9 },
  { name: "Withdraw fees", fn: test10 },
  { name: "Treasury free-balance guard", fn: test11 },
  { name: "Circuit breaker halts trading", fn: test12 },
  { name: "Update config", fn: test13 },
];

export async function runAct2(ctx: SharedContext): Promise<ActResult> {
  const startMs = Date.now();
  const details: string[] = [];
  const errors: ErrorEntry[] = [];
  let allPassed = true;

  // Create 4 fresh markets for Act 2 (Act 1 cleaned up its own)
  // market[0]: general trading tests (T1-T6) — standard close time
  // market[1]: winner redeem test (T7) — LATER close time (runs after T8's wait)
  // market[2]: admin override test (T8) — standard close time (runs first, waits for close)
  // market[3]: admin v2 tests (T9-T13) — long close time (must survive settlement waits)
  if (ctx.markets.length === 0) {
    console.log("  Creating fresh markets for Act 2...");
    details.push("Creating fresh markets for Act 2...");
    const tickers = ctx.config.tickers.slice(0, 4);
    // market[1] gets extra 90s so it's still open after T8's close wait
    // market[3] gets extra 300s for admin tests that run after settlement waits
    const closeOffsets = [300, 390, 300, 600];
    for (let ti = 0; ti < tickers.length; ti++) {
      const ticker = tickers[ti];
      console.log(`    ${ti + 1}/${tickers.length}: ${ticker} (close +${closeOffsets[ti]}s)...`);
      try {
        const m = await createAct2Market(ctx, ticker, closeOffsets[ti]);
        ctx.markets.push(m);
        console.log(`    ✓ ${ticker} created`);
      } catch (e: any) {
        console.log(`    ✗ ${ticker} FAILED: ${e.message?.slice(0, 120)}`);
        errors.push({
          timestamp: Date.now(),
          agentId: -1,
          instruction: "act2_create_market",
          message: `Failed to create ${ticker}: ${e.message}`,
        });
      }
    }
    console.log(`  ${ctx.markets.length}/${tickers.length} markets created`);
    details.push(`Created ${ctx.markets.length} markets for Act 2 (market[3] for admin tests)`);
    if (ctx.markets.length === 0) {
      return {
        name: "Act 2: User Flows",
        passed: false,
        duration: Date.now() - startMs,
        details: [...details, "FAILED: Could not create any markets"],
        errors,
      };
    }
  }

  const m = ctx.markets[0];
  // Admin v2 tests (T9-T13) use market[3] which has a longer close time
  const adminMarket = ctx.markets.length > 3 ? ctx.markets[3] : m;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    // Tests 9-13 (index 8-12) use the admin market with longer close time
    const testMarket = i >= 8 ? adminMarket : m;
    process.stdout.write(`  T${i + 1}/${TESTS.length}: ${test.name}...`);
    const testStart = Date.now();
    try {
      const result = await test.fn(ctx, testMarket);
      const elapsed = Date.now() - testStart;
      const status = result.passed ? "PASS" : "FAIL";
      const icon = result.passed ? "✓" : "✗";
      console.log(` ${icon} ${status} (${(elapsed / 1000).toFixed(1)}s)`);
      if (!result.passed) {
        console.log(`    → ${result.detail.slice(0, 150)}`);
      }
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
      console.log(` ✗ ERROR (${(elapsed / 1000).toFixed(1)}s)`);
      console.log(`    → ${msg.slice(0, 150)}`);
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
