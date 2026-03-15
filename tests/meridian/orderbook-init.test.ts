import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
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
  OB_DISCRIMINATOR_SIZE,
  HEADER_SIZE,
  HDR_MARKET,
  HDR_NEXT_ORDER_ID,
  HDR_PRICE_MAP,
  HDR_LEVEL_COUNT,
  HDR_MAX_LEVELS,
  HDR_BUMP,
  MAX_PRICE_LEVELS,
  PRICE_UNALLOCATED,
  sparseBookDiscriminator,
} from "../helpers";

describe("OrderBook Initialization (Sparse)", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;
  let marketAccounts: MarketAccounts;

  const TICKER = "MSFT";
  const STRIKE_PRICE = 400_000_000;
  const PREVIOUS_CLOSE = 395_000_000;
  let MARKET_CLOSE_UNIX: number;

  before(async () => {
    ctx = await setupBankrun();
    const clock = await ctx.context.banksClient.getClock();
    MARKET_CLOSE_UNIX = Number(clock.unixTimestamp) + 86400 * 30;
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 398_000_000, 500_000);

    marketAccounts = await createTestMarket(
      ctx.context,
      ctx.admin,
      config,
      TICKER,
      STRIKE_PRICE,
      MARKET_CLOSE_UNIX,
      PREVIOUS_CLOSE,
      oracleFeed,
      usdcMint,
    );
  });

  it("creates sparse order book with header-only size (168 bytes)", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);
    expect(data.length).to.equal(HEADER_SIZE);
  });

  it("has correct discriminator", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    const disc = sparseBookDiscriminator();
    expect(data.subarray(0, OB_DISCRIMINATOR_SIZE).equals(disc)).to.be.true;
  });

  it("initializes next_order_id to 0", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    const nextOrderId = new BN(data.subarray(HDR_NEXT_ORDER_ID, HDR_NEXT_ORDER_ID + 8), "le");
    expect(nextOrderId.toNumber()).to.equal(0);
  });

  it("initializes all 99 price_map entries as unallocated (0xFF)", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    for (let i = 0; i < MAX_PRICE_LEVELS; i++) {
      const offset = HDR_PRICE_MAP + i * 2;
      const val = data.readUInt16LE(offset);
      expect(val, `price_map[${i}] should be 0xFFFF`).to.equal(PRICE_UNALLOCATED);
    }
  });

  it("initializes level_count and max_levels to 0", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    expect(data[HDR_LEVEL_COUNT]).to.equal(0);
    expect(data[HDR_MAX_LEVELS]).to.equal(0);
  });

  it("header size is 270 bytes (no levels allocated yet)", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    expect(data.length).to.equal(HEADER_SIZE);
  });

  it("stores market pubkey in order book header", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    const storedMarket = new PublicKey(data.subarray(HDR_MARKET, HDR_MARKET + 32));
    expect(storedMarket.toBase58()).to.equal(marketAccounts.market.toBase58());
  });

  it("stores correct bump in header", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    const data = Buffer.from(acctInfo!.data);
    const [, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_book"), marketAccounts.market.toBuffer()],
      new PublicKey("7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth"),
    );
    expect(data[HDR_BUMP]).to.equal(expectedBump);
  });
});
