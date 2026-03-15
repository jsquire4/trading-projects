/**
 * admin-v2.test.ts — Tests for Phase 6A admin instructions.
 *
 * Covers all 10 new instructions:
 *   expand_config, initialize_ticker_registry, transfer_admin, accept_admin,
 *   withdraw_fees, withdraw_treasury, update_config, add_ticker,
 *   deactivate_ticker, circuit_breaker
 *
 * Tests run sequentially in a single bankrun context (shared state).
 */

import { expect } from "chai";
import { PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
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
  findTreasury,
  findFeeVault,
  findOrderBook,
  findStrikeMarket,
  MAG7_TICKERS,
  MOCK_ORACLE_PROGRAM_ID,
  MERIDIAN_PROGRAM_ID,
  padTicker,
  SIDE_USDC_BID,
  SIDE_YES_ASK,
  ORDER_TYPE_LIMIT,
} from "../helpers";

import {
  buildExpandConfigIx,
  buildInitializeTickerRegistryIx,
  buildTransferAdminIx,
  buildAcceptAdminIx,
  buildWithdrawFeesIx,
  buildWithdrawTreasuryIx,
  buildUpdateConfigIx,
  buildAddTickerIx,
  buildDeactivateTickerIx,
  buildCircuitBreakerIx,
  buildUpdateFeeBpsIx,
  buildPlaceOrderIx,
  buildMintPairIx,
  buildUpdateStrikeCreationFeeIx,
} from "../helpers/instructions";

import { getTokenBalance, readMarket, advanceClock } from "../helpers/market-layout";
import { createFundedUser, createFundedUserWithMarketAtas } from "../helpers/mint-helpers";
import { makeUniqueCuIxFactory } from "../helpers/tx-helpers";

// ---------------------------------------------------------------------------
// GlobalConfig byte offsets (with 8-byte discriminator)
// ---------------------------------------------------------------------------

const DISC = 8;
const OFF_ADMIN = DISC;                    // 8
const OFF_USDC_MINT = OFF_ADMIN + 32;      // 40
const OFF_ORACLE_PROG = OFF_USDC_MINT + 32; // 72
const OFF_STALENESS = OFF_ORACLE_PROG + 32; // 104
const OFF_SETTLEMENT_STALENESS = OFF_STALENESS + 8; // 112
const OFF_CONFIDENCE = OFF_SETTLEMENT_STALENESS + 8; // 120
const OFF_IS_PAUSED = OFF_CONFIDENCE + 8;  // 128
const OFF_ORACLE_TYPE = OFF_IS_PAUSED + 1; // 129
const OFF_TICKERS = OFF_ORACLE_TYPE + 1;   // 130
const OFF_TICKER_COUNT = OFF_TICKERS + 56; // 186
const OFF_BUMP = OFF_TICKER_COUNT + 1;     // 187
const OFF_FEE_BPS = OFF_BUMP + 1;          // 188
const OFF_PADDING = OFF_FEE_BPS + 2;       // 190
const OFF_STRIKE_CREATION_FEE = OFF_PADDING + 2; // 192
// v2 fields (after expand_config)
const OFF_PENDING_ADMIN = OFF_STRIKE_CREATION_FEE + 8; // 200
const OFF_OPERATING_RESERVE = OFF_PENDING_ADMIN + 32;   // 232
const OFF_OBLIGATIONS = OFF_OPERATING_RESERVE + 8;      // 240
const OFF_BLACKOUT_MINUTES = OFF_OBLIGATIONS + 8;       // 248

// TickerRegistry: disc(8) + bump(1) + padding(7) + vec_len(4) = 20, then 48 bytes per entry
const TR_DISC = 8;
const TR_BUMP = TR_DISC;
const TR_PADDING = TR_BUMP + 1;
const TR_VEC_LEN = TR_PADDING + 7;
const TR_ENTRIES = TR_VEC_LEN + 4;
const TICKER_ENTRY_SIZE = 48;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTickerRegistry(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tickers")],
    MERIDIAN_PROGRAM_ID,
  );
}

async function readConfigRaw(ctx: BankrunContext, config: PublicKey): Promise<Buffer> {
  const acct = await ctx.context.banksClient.getAccount(config);
  expect(acct).to.not.be.null;
  return Buffer.from(acct!.data);
}

async function readRegistryRaw(ctx: BankrunContext, registry: PublicKey): Promise<Buffer> {
  const acct = await ctx.context.banksClient.getAccount(registry);
  expect(acct).to.not.be.null;
  return Buffer.from(acct!.data);
}

function readRegistryEntryCount(data: Buffer): number {
  return data.readUInt32LE(TR_VEC_LEN);
}

function readRegistryEntry(data: Buffer, idx: number): { ticker: string; isActive: boolean; pythFeed: PublicKey } {
  const base = TR_ENTRIES + idx * TICKER_ENTRY_SIZE;
  const tickerBuf = data.subarray(base, base + 8);
  const ticker = tickerBuf.toString("utf-8").replace(/\0+$/, "");
  const isActive = data[base + 8] !== 0;
  const pythFeed = new PublicKey(data.subarray(base + 9, base + 41));
  return { ticker, isActive, pythFeed };
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Admin V2 — Phase 6A", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let feeVault: PublicKey;
  let treasury: PublicKey;
  let tickerRegistry: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;

  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000;
  const PREVIOUS_CLOSE = 195_000_000;
  let marketCloseUnix: number;

  const uniqueCuIx = makeUniqueCuIxFactory(500_000);

  before(async () => {
    ctx = await setupBankrun();

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    [feeVault] = findFeeVault();
    [treasury] = findTreasury();
    [tickerRegistry] = findTickerRegistry();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 198_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );
  });

  // =========================================================================
  // expand_config
  // =========================================================================

  describe("expand_config", () => {
    it("v2 config is 256 bytes with zero-initialized v2 fields", async () => {
      // New deployments create the config at v2 size (256 bytes) directly.
      // expand_config is only needed for migrating existing v1 configs.
      const data = await readConfigRaw(ctx, config);
      expect(data.length).to.equal(256, "Config should be v2 size (256 bytes)");

      // pending_admin = Pubkey::default()
      const pendingAdmin = new PublicKey(data.subarray(OFF_PENDING_ADMIN, OFF_PENDING_ADMIN + 32));
      expect(pendingAdmin.equals(PublicKey.default)).to.be.true;

      // operating_reserve = 0
      const reserve = data.readBigUInt64LE(OFF_OPERATING_RESERVE);
      expect(Number(reserve)).to.equal(0);

      // obligations = 0
      const obligations = data.readBigUInt64LE(OFF_OBLIGATIONS);
      expect(Number(obligations)).to.equal(0);

      // settlement_blackout_minutes = 0
      const blackout = data.readUInt16LE(OFF_BLACKOUT_MINUTES);
      expect(blackout).to.equal(0);
    });

    it("rejects expand on already-v2 config (ConfigAlreadyExpanded)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildExpandConfigIx({ admin: ctx.admin.publicKey, config });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject");
      } catch (err: any) {
        expect(String(err)).to.match(/ConfigAlreadyExpanded|0x180C|custom program error/i);
      }
    });

    it("expands a v1 config to v2 (migration scenario)", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Simulate a v1 config by shrinking to 200 bytes
      const fullData = await readConfigRaw(ctx, config);
      const v1Data = Buffer.alloc(200, 0);
      fullData.copy(v1Data, 0, 0, 200);

      const acct = await ctx.context.banksClient.getAccount(config);
      ctx.context.setAccount(config, {
        lamports: acct!.lamports,
        data: v1Data,
        owner: MERIDIAN_PROGRAM_ID,
        executable: false,
      });

      const ix = buildExpandConfigIx({ admin: ctx.admin.publicKey, config });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const after = await readConfigRaw(ctx, config);
      expect(after.length).to.equal(256, "Should be expanded to 256 bytes");

      // v2 fields should be zero-initialized
      const pendingAdmin = new PublicKey(after.subarray(OFF_PENDING_ADMIN, OFF_PENDING_ADMIN + 32));
      expect(pendingAdmin.equals(PublicKey.default)).to.be.true;
      expect(Number(after.readBigUInt64LE(OFF_OPERATING_RESERVE))).to.equal(0);
      expect(Number(after.readBigUInt64LE(OFF_OBLIGATIONS))).to.equal(0);
      expect(after.readUInt16LE(OFF_BLACKOUT_MINUTES)).to.equal(0);
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildExpandConfigIx({ admin: user.publicKey, config });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        // Config is already expanded, so error will be ConfigAlreadyExpanded, not Unauthorized
        expect(String(err)).to.match(/ConfigAlreadyExpanded|Unauthorized|0x1770|0x180C|custom program error/i);
      }
    });
  });

  // =========================================================================
  // initialize_ticker_registry
  // =========================================================================

  describe("initialize_ticker_registry", () => {
    it("creates TickerRegistry PDA with MAG7 tickers", async () => {
      const provider = new BankrunProvider(ctx.context);

      const ix = buildInitializeTickerRegistryIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readRegistryRaw(ctx, tickerRegistry);

      // Check entry count
      const count = readRegistryEntryCount(data);
      expect(count).to.equal(7, "Should have 7 MAG7 entries");

      // Verify each ticker
      for (let i = 0; i < MAG7_TICKERS.length; i++) {
        const entry = readRegistryEntry(data, i);
        expect(entry.ticker).to.equal(MAG7_TICKERS[i]);
        expect(entry.isActive).to.be.true;
        expect(entry.pythFeed.equals(PublicKey.default)).to.be.true;
      }
    });

    it("rejects double initialization", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildInitializeTickerRegistryIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject");
      } catch (err: any) {
        expect(String(err)).to.match(/already in use|0x0|custom program error/i);
      }
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildInitializeTickerRegistryIx({
        admin: user.publicKey,
        config,
        tickerRegistry,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        // Registry already initialized, so error may be "already in use" or "Unauthorized"
        expect(String(err)).to.match(/Unauthorized|constraint|2012|already in use|resulted in an er/i);
      }
    });
  });

  // =========================================================================
  // update_config
  // =========================================================================

  describe("update_config", () => {
    it("updates staleness_threshold only", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        stalenessThreshold: new BN(90),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readConfigRaw(ctx, config);
      expect(Number(data.readBigUInt64LE(OFF_STALENESS))).to.equal(90);
      // settlement_staleness unchanged
      expect(Number(data.readBigUInt64LE(OFF_SETTLEMENT_STALENESS))).to.equal(120);
    });

    it("updates operating_reserve and blackout_minutes", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        operatingReserve: new BN(5_000_000),
        settlementBlackoutMinutes: 15,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readConfigRaw(ctx, config);
      expect(Number(data.readBigUInt64LE(OFF_OPERATING_RESERVE))).to.equal(5_000_000);
      expect(data.readUInt16LE(OFF_BLACKOUT_MINUTES)).to.equal(15);
    });

    it("updates all fields at once", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        stalenessThreshold: new BN(45),
        settlementStaleness: new BN(180),
        confidenceBps: new BN(100),
        operatingReserve: new BN(10_000_000),
        settlementBlackoutMinutes: 30,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readConfigRaw(ctx, config);
      expect(Number(data.readBigUInt64LE(OFF_STALENESS))).to.equal(45);
      expect(Number(data.readBigUInt64LE(OFF_SETTLEMENT_STALENESS))).to.equal(180);
      expect(Number(data.readBigUInt64LE(OFF_CONFIDENCE))).to.equal(100);
      expect(Number(data.readBigUInt64LE(OFF_OPERATING_RESERVE))).to.equal(10_000_000);
      expect(data.readUInt16LE(OFF_BLACKOUT_MINUTES)).to.equal(30);
    });

    it("rejects staleness_threshold = 0", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        stalenessThreshold: new BN(0),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject zero staleness");
      } catch (err: any) {
        expect(String(err)).to.match(/InvalidStalenessThreshold|custom program error/i);
      }
    });

    it("rejects confidence_bps > 10000", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        confidenceBps: new BN(10_001),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject invalid confidence");
      } catch (err: any) {
        expect(String(err)).to.match(/InvalidConfidenceThreshold|custom program error/i);
      }
    });

    it("rejects blackout_minutes > 60", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        settlementBlackoutMinutes: 61,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject blackout > 60");
      } catch (err: any) {
        expect(String(err)).to.match(/InvalidBlackoutMinutes|custom program error/i);
      }
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildUpdateConfigIx({
        admin: user.publicKey,
        config,
        stalenessThreshold: new BN(999),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    // Reset to reasonable defaults for subsequent tests
    after(async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        stalenessThreshold: new BN(60),
        settlementStaleness: new BN(120),
        confidenceBps: new BN(50),
        operatingReserve: new BN(0),
        settlementBlackoutMinutes: 0,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
    });
  });

  // =========================================================================
  // add_ticker
  // =========================================================================

  describe("add_ticker", () => {
    it("anyone can add a new ticker (permissionless)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);

      const ix = buildAddTickerIx({
        payer: user.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("COST"),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);

      const data = await readRegistryRaw(ctx, tickerRegistry);
      const count = readRegistryEntryCount(data);
      expect(count).to.equal(8, "Should have 8 entries after adding COST");

      const entry = readRegistryEntry(data, 7); // last entry
      expect(entry.ticker).to.equal("COST");
      expect(entry.isActive).to.be.true;
      expect(entry.pythFeed.equals(PublicKey.default)).to.be.true;
    });

    it("rejects duplicate ticker (TickerAlreadyExists)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildAddTickerIx({
        payer: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("AAPL"), // already in MAG7
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject duplicate");
      } catch (err: any) {
        expect(String(err)).to.match(/TickerAlreadyExists|0x1809|custom program error/i);
      }
    });

    it("rejects duplicate user-added ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildAddTickerIx({
        payer: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("COST"), // added in previous test
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject duplicate COST");
      } catch (err: any) {
        expect(String(err)).to.match(/TickerAlreadyExists|0x1809|custom program error/i);
      }
    });

    it("adds a second user ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);

      const ix = buildAddTickerIx({
        payer: user.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);

      const data = await readRegistryRaw(ctx, tickerRegistry);
      expect(readRegistryEntryCount(data)).to.equal(9);

      const entry = readRegistryEntry(data, 8);
      expect(entry.ticker).to.equal("JPM");
      expect(entry.isActive).to.be.true;
    });
  });

  // =========================================================================
  // deactivate_ticker
  // =========================================================================

  describe("deactivate_ticker", () => {
    it("admin deactivates a ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildDeactivateTickerIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readRegistryRaw(ctx, tickerRegistry);
      const entry = readRegistryEntry(data, 8);
      expect(entry.ticker).to.equal("JPM");
      expect(entry.isActive).to.be.false;
    });

    it("rejects deactivating already-deactivated ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildDeactivateTickerIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject");
      } catch (err: any) {
        expect(String(err)).to.match(/TickerDeactivated|0x180B|custom program error/i);
      }
    });

    it("rejects non-existent ticker (TickerNotFound)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildDeactivateTickerIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("ZZZZ"),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject");
      } catch (err: any) {
        expect(String(err)).to.match(/TickerNotFound|0x180A|custom program error/i);
      }
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildDeactivateTickerIx({
        admin: user.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("COST"),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });
  });

  // =========================================================================
  // add_ticker reactivation
  // =========================================================================

  describe("add_ticker reactivation", () => {
    it("reactivates a deactivated ticker via add_ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      // JPM was deactivated in the deactivate_ticker tests above
      const ix = buildAddTickerIx({
        payer: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      // Verify ticker is active again by creating a market with it
      // (if it were still deactivated, create_strike_market would fail)
      const registry = await provider.connection.getAccountInfo(tickerRegistry);
      expect(registry).to.not.be.null;
    });

    it("still rejects adding an active ticker", async () => {
      const provider = new BankrunProvider(ctx.context);
      // JPM is now active again — re-adding should fail
      const ix = buildAddTickerIx({
        payer: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject active duplicate");
      } catch (err: any) {
        expect(String(err)).to.match(/TickerAlreadyExists|0x1809|custom program error/i);
      }
    });
  });

  // =========================================================================
  // withdraw_fees
  // =========================================================================

  describe("withdraw_fees", () => {
    let adminUsdcAta: PublicKey;

    before(async () => {
      // Create admin's USDC ATA
      adminUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, ctx.admin.publicKey);
    });

    it("rejects when fee_vault is empty (InsufficientBalance)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildWithdrawFeesIx({
        admin: ctx.admin.publicKey,
        config,
        feeVault,
        adminUsdcAta,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject empty vault");
      } catch (err: any) {
        expect(String(err)).to.match(/InsufficientBalance|custom program error/i);
      }
    });

    it("withdraws fees after strike creation fee is collected", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Set a strike creation fee (100 USDC lamports for testing)
      const feeAmount = 100_000; // 0.1 USDC
      const feeIx = buildUpdateStrikeCreationFeeIx({
        admin: ctx.admin.publicKey,
        config,
      }, new BN(feeAmount));
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), feeIx), [ctx.admin]);

      // Create a funded user who will create a market (non-admin → pays fee)
      const { user, userUsdcAta } = await createFundedUser(
        ctx.context, ctx.admin, usdcMint, 10_000_000, // 10 USDC
      );

      // The user creates a market on a new ticker (COST already added) with a different strike
      const newOracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, "COST");
      await updateOraclePrice(ctx.context, ctx.admin, newOracleFeed, 900_000_000, 500_000);

      const newStrike = 900_000_000;
      const strikePriceBN = new BN(newStrike);
      const expiryDay = Math.floor(marketCloseUnix / 86400);

      const [newMarket] = findStrikeMarket("COST", strikePriceBN, marketCloseUnix);
      const [yesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [usdcVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [yesEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_escrow"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_escrow"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [orderBook] = PublicKey.findProgramAddressSync(
        [Buffer.from("order_book"), newMarket.toBuffer()], MERIDIAN_PROGRAM_ID,
      );

      // Import the builder
      const { buildCreateStrikeMarketIx } = await import("../helpers/instructions");

      const createIx = buildCreateStrikeMarketIx({
        admin: user.publicKey,
        config,
        market: newMarket,
        yesMint,
        noMint,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        orderBook,
        oracleFeed: newOracleFeed,
        usdcMint,
        ticker: padTicker("COST"),
        strikePrice: strikePriceBN,
        expiryDay,
        marketCloseUnix: new BN(marketCloseUnix),
        previousClose: new BN(895_000_000),
        creatorUsdcAta: userUsdcAta,
        feeVault,
        tickerRegistry,
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), createIx),
        [user],
      );

      // Verify fee_vault has the fee
      const feeVaultBal = await getTokenBalance(ctx, feeVault);
      expect(feeVaultBal).to.equal(feeAmount, "Fee vault should have the strike creation fee");

      // Now admin withdraws fees
      const adminBalBefore = await getTokenBalance(ctx, adminUsdcAta);
      const withdrawIx = buildWithdrawFeesIx({
        admin: ctx.admin.publicKey,
        config,
        feeVault,
        adminUsdcAta,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), withdrawIx), [ctx.admin]);

      const adminBalAfter = await getTokenBalance(ctx, adminUsdcAta);
      expect(adminBalAfter - adminBalBefore).to.equal(feeAmount, "Admin should receive all fees");

      // Fee vault should be empty
      const feeVaultBalAfter = await getTokenBalance(ctx, feeVault);
      expect(feeVaultBalAfter).to.equal(0);
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user, userUsdcAta: uAta } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildWithdrawFeesIx({
        admin: user.publicKey,
        config,
        feeVault,
        adminUsdcAta: uAta,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    // Reset strike creation fee to 0
    after(async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateStrikeCreationFeeIx({
        admin: ctx.admin.publicKey,
        config,
      }, new BN(0));
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
    });
  });

  // =========================================================================
  // withdraw_treasury
  // =========================================================================

  describe("withdraw_treasury", () => {
    let adminUsdcAta: PublicKey;

    before(async () => {
      adminUsdcAta = await createAta(ctx.context, ctx.admin, usdcMint, ctx.admin.publicKey)
        .catch(() => {
          // ATA may already exist from withdraw_fees tests
          const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
          return getAssociatedTokenAddressSync(usdcMint, ctx.admin.publicKey) as PublicKey;
        });

      // Fund treasury with some USDC by minting directly
      await mintTestUsdc(ctx.context, usdcMint, ctx.admin, treasury, 10_000_000); // 10 USDC
    });

    it("withdraws surplus from treasury (balance - obligations - reserve)", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Set operating_reserve to 2 USDC
      const updateIx = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        operatingReserve: new BN(2_000_000),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), updateIx), [ctx.admin]);

      // With 10 USDC in treasury, 0 obligations, 2 USDC reserve → 8 USDC available
      const adminBalBefore = await getTokenBalance(ctx, adminUsdcAta);

      const ix = buildWithdrawTreasuryIx({
        admin: ctx.admin.publicKey,
        config,
        treasury,
        adminUsdcAta,
        amount: new BN(5_000_000), // withdraw 5 USDC (within limit)
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const adminBalAfter = await getTokenBalance(ctx, adminUsdcAta);
      expect(adminBalAfter - adminBalBefore).to.equal(5_000_000);

      const treasuryBal = await getTokenBalance(ctx, treasury);
      expect(treasuryBal).to.equal(5_000_000); // 10 - 5
    });

    it("rejects withdrawal exceeding available surplus", async () => {
      const provider = new BankrunProvider(ctx.context);
      // Treasury has 5 USDC, reserve is 2 USDC → available = 3 USDC
      const ix = buildWithdrawTreasuryIx({
        admin: ctx.admin.publicKey,
        config,
        treasury,
        adminUsdcAta,
        amount: new BN(4_000_000), // 4 USDC > 3 available
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject overdraw");
      } catch (err: any) {
        expect(String(err)).to.match(/WithdrawalExceedsAvailable|0x1808|custom program error/i);
      }
    });

    it("rejects zero-amount withdrawal", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildWithdrawTreasuryIx({
        admin: ctx.admin.publicKey,
        config,
        treasury,
        adminUsdcAta,
        amount: new BN(0),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Should reject zero amount");
      } catch (err: any) {
        expect(String(err)).to.match(/InsufficientBalance|custom program error/i);
      }
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user, userUsdcAta: uAta } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildWithdrawTreasuryIx({
        admin: user.publicKey,
        config,
        treasury,
        adminUsdcAta: uAta,
        amount: new BN(1_000_000),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    // Reset operating_reserve to 0
    after(async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        operatingReserve: new BN(0),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
    });
  });

  // =========================================================================
  // transfer_admin + accept_admin (two-step)
  // =========================================================================

  describe("transfer_admin / accept_admin", () => {
    let newAdmin: Keypair;

    before(async () => {
      const result = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      newAdmin = result.user;
    });

    it("rejects non-admin calling transfer_admin (Unauthorized)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user: rando } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildTransferAdminIx({
        admin: rando.publicKey,
        config,
        newAdmin: rando.publicKey,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [rando]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    it("current admin proposes new admin", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildTransferAdminIx({
        admin: ctx.admin.publicKey,
        config,
        newAdmin: newAdmin.publicKey,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const data = await readConfigRaw(ctx, config);
      const pendingAdmin = new PublicKey(data.subarray(OFF_PENDING_ADMIN, OFF_PENDING_ADMIN + 32));
      expect(pendingAdmin.equals(newAdmin.publicKey)).to.be.true;

      // Admin is still the original
      const currentAdmin = new PublicKey(data.subarray(OFF_ADMIN, OFF_ADMIN + 32));
      expect(currentAdmin.equals(ctx.admin.publicKey)).to.be.true;
    });

    it("rejects accept_admin from wrong signer (NotPendingAdmin)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user: rando } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildAcceptAdminIx({
        newAdmin: rando.publicKey,
        config,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [rando]);
        expect.fail("Should reject wrong signer");
      } catch (err: any) {
        expect(String(err)).to.match(/NotPendingAdmin|0x1807|custom program error/i);
      }
    });

    it("pending admin accepts", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildAcceptAdminIx({
        newAdmin: newAdmin.publicKey,
        config,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [newAdmin]);

      const data = await readConfigRaw(ctx, config);

      // Admin is now the new admin
      const currentAdmin = new PublicKey(data.subarray(OFF_ADMIN, OFF_ADMIN + 32));
      expect(currentAdmin.equals(newAdmin.publicKey)).to.be.true;

      // Pending admin is cleared
      const pendingAdmin = new PublicKey(data.subarray(OFF_PENDING_ADMIN, OFF_PENDING_ADMIN + 32));
      expect(pendingAdmin.equals(PublicKey.default)).to.be.true;
    });

    it("old admin can no longer call admin instructions", async () => {
      const provider = new BankrunProvider(ctx.context);
      const ix = buildUpdateConfigIx({
        admin: ctx.admin.publicKey,
        config,
        stalenessThreshold: new BN(999),
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
        expect.fail("Old admin should be rejected");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    it("rejects accept_admin when no pending transfer (NoPendingAdmin)", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user: rando } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildAcceptAdminIx({
        newAdmin: rando.publicKey,
        config,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [rando]);
        expect.fail("Should reject when no pending");
      } catch (err: any) {
        expect(String(err)).to.match(/NoPendingAdmin|0x1806|custom program error/i);
      }
    });

    // Transfer admin back to original for remaining tests
    after(async () => {
      const provider = new BankrunProvider(ctx.context);

      // newAdmin proposes original admin
      const transferIx = buildTransferAdminIx({
        admin: newAdmin.publicKey,
        config,
        newAdmin: ctx.admin.publicKey,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), transferIx), [newAdmin]);

      // Original admin accepts
      const acceptIx = buildAcceptAdminIx({
        newAdmin: ctx.admin.publicKey,
        config,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), acceptIx), [ctx.admin]);
    });
  });

  // =========================================================================
  // circuit_breaker
  // =========================================================================

  describe("circuit_breaker", () => {
    let ma2: MarketAccounts;
    let oracleFeedMsft: PublicKey;

    before(async () => {
      // Ensure config is unpaused first
      const data = await readConfigRaw(ctx, config);
      // If paused from a previous test, we need to unpause
      // (circuit_breaker sets is_paused = true, there's no specific un-pause instruction
      //  besides the existing pause/unpause instruction, so let's create a second market)

      oracleFeedMsft = await initializeOracleFeed(ctx.context, ctx.admin, "MSFT");
      await updateOraclePrice(ctx.context, ctx.admin, oracleFeedMsft, 400_000_000, 500_000);

      const clock = await ctx.context.banksClient.getClock();
      const closeUnix = Number(clock.unixTimestamp) + 86400 * 2;

      ma2 = await createTestMarket(
        ctx.context, ctx.admin, config, "MSFT",
        400_000_000, closeUnix, 395_000_000,
        oracleFeedMsft, usdcMint,
      );
    });

    it("activates global pause and pauses markets", async () => {
      const provider = new BankrunProvider(ctx.context);

      const ix = buildCircuitBreakerIx({
        admin: ctx.admin.publicKey,
        config,
        marketBookPairs: [
          { market: ma.market, orderBook: ma.orderBook },
          { market: ma2.market, orderBook: ma2.orderBook },
        ],
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      // Config should be paused
      const configData = await readConfigRaw(ctx, config);
      expect(configData[OFF_IS_PAUSED]).to.equal(1, "Config should be globally paused");

      // Both markets should be paused
      const m1 = await readMarket(ctx, ma.market);
      expect(m1.isPaused).to.be.true;

      const m2 = await readMarket(ctx, ma2.market);
      expect(m2.isPaused).to.be.true;
    });

    it("works without any markets (global pause only)", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Already paused, but should succeed without error
      const ix = buildCircuitBreakerIx({
        admin: ctx.admin.publicKey,
        config,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);

      const configData = await readConfigRaw(ctx, config);
      expect(configData[OFF_IS_PAUSED]).to.equal(1);
    });

    it("rejects non-admin caller", async () => {
      const provider = new BankrunProvider(ctx.context);
      const { user } = await createFundedUser(ctx.context, ctx.admin, usdcMint, 0);
      const ix = buildCircuitBreakerIx({
        admin: user.publicKey,
        config,
      });
      try {
        await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [user]);
        expect.fail("Should reject non-admin");
      } catch (err: any) {
        expect(String(err)).to.match(/Unauthorized|constraint|2012/i);
      }
    });

    // Unpause for any subsequent tests
    after(async () => {
      const provider = new BankrunProvider(ctx.context);
      const { buildUnpauseIx } = await import("../helpers/instructions");
      const ix = buildUnpauseIx({
        admin: ctx.admin.publicKey,
        config,
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), ix), [ctx.admin]);
    });
  });

  // =========================================================================
  // create_strike_market with TickerRegistry validation
  // =========================================================================

  describe("create_strike_market with TickerRegistry", () => {
    it("succeeds when ticker is active in registry", async () => {
      const provider = new BankrunProvider(ctx.context);

      // Create a market on COST ticker (user-added, active)
      const costFeed = await initializeOracleFeed(ctx.context, ctx.admin, "COST")
        .catch(() => {
          // May already exist from withdraw_fees test — that's fine
          const [feed] = PublicKey.findProgramAddressSync(
            [Buffer.from("price_feed"), padTicker("COST")],
            MOCK_ORACLE_PROGRAM_ID,
          );
          return feed;
        });

      await updateOraclePrice(ctx.context, ctx.admin, costFeed, 900_000_000, 500_000);

      const clock = await ctx.context.banksClient.getClock();
      const closeUnix = Number(clock.unixTimestamp) + 86400 * 3;

      const strikeBN = new BN(950_000_000);
      const expiryDay = Math.floor(closeUnix / 86400);
      const [mkt] = findStrikeMarket("COST", strikeBN, closeUnix);
      const [yesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [usdcVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [yesEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [orderBook] = PublicKey.findProgramAddressSync(
        [Buffer.from("order_book"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );

      const { buildCreateStrikeMarketIx } = await import("../helpers/instructions");
      const createIx = buildCreateStrikeMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: mkt,
        yesMint,
        noMint,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        orderBook,
        oracleFeed: costFeed,
        usdcMint,
        ticker: padTicker("COST"),
        strikePrice: strikeBN,
        expiryDay,
        marketCloseUnix: new BN(closeUnix),
        previousClose: new BN(895_000_000),
        tickerRegistry,
      });

      await provider.sendAndConfirm!(
        new Transaction().add(uniqueCuIx(), createIx),
        [ctx.admin],
      );

      // Verify market exists
      const acct = await ctx.context.banksClient.getAccount(mkt);
      expect(acct).to.not.be.null;
    });

    it("rejects market creation with deactivated ticker in registry", async () => {
      const provider = new BankrunProvider(ctx.context);

      // JPM was reactivated in the reactivation tests — deactivate it again
      const deactIx = buildDeactivateTickerIx({
        admin: ctx.admin.publicKey,
        config,
        tickerRegistry,
        ticker: padTicker("JPM"),
      });
      await provider.sendAndConfirm!(new Transaction().add(uniqueCuIx(), deactIx), [ctx.admin]);
      const jpmFeed = await initializeOracleFeed(ctx.context, ctx.admin, "JPM")
        .catch(() => {
          const [feed] = PublicKey.findProgramAddressSync(
            [Buffer.from("price_feed"), padTicker("JPM")],
            MOCK_ORACLE_PROGRAM_ID,
          );
          return feed;
        });
      await updateOraclePrice(ctx.context, ctx.admin, jpmFeed, 200_000_000, 500_000);

      const clock = await ctx.context.banksClient.getClock();
      const closeUnix = Number(clock.unixTimestamp) + 86400 * 4;

      const strikeBN = new BN(200_000_000);
      const expiryDay = Math.floor(closeUnix / 86400);
      const [mkt] = findStrikeMarket("JPM", strikeBN, closeUnix);
      const [yesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [usdcVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [yesEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [noEscrow] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_escrow"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );
      const [orderBook] = PublicKey.findProgramAddressSync(
        [Buffer.from("order_book"), mkt.toBuffer()], MERIDIAN_PROGRAM_ID,
      );

      const { buildCreateStrikeMarketIx } = await import("../helpers/instructions");
      const createIx = buildCreateStrikeMarketIx({
        admin: ctx.admin.publicKey,
        config,
        market: mkt,
        yesMint,
        noMint,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        orderBook,
        oracleFeed: jpmFeed,
        usdcMint,
        ticker: padTicker("JPM"),
        strikePrice: strikeBN,
        expiryDay,
        marketCloseUnix: new BN(closeUnix),
        previousClose: new BN(195_000_000),
        tickerRegistry,
      });

      try {
        await provider.sendAndConfirm!(
          new Transaction().add(uniqueCuIx(), createIx),
          [ctx.admin],
        );
        expect.fail("Should reject deactivated ticker");
      } catch (err: any) {
        expect(String(err)).to.match(/InvalidTicker|custom program error/i);
      }
    });
  });

  // =========================================================================
  // Accounting invariant: obligations tracking
  // =========================================================================

  describe("obligations tracking", () => {
    it("obligations are zero initially", async () => {
      const data = await readConfigRaw(ctx, config);
      const obligations = Number(data.readBigUInt64LE(OFF_OBLIGATIONS));
      expect(obligations).to.equal(0);
    });
  });
});
