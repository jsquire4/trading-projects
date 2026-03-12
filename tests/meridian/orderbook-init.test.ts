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
  OB_TOTAL_LEN,
  OB_PRICE_LEVEL_SIZE,
  OB_LEVELS_OFFSET,
} from "../helpers";

describe("OrderBook Initialization", () => {
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
    // Use bankrun clock instead of host wall clock for consistency
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

  it("creates order book with correct size", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);
    expect(data.length).to.equal(OB_DISCRIMINATOR_SIZE + OB_TOTAL_LEN);
  });

  it("initializes next_order_id to 0", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);

    // next_order_id is at offset 8 (disc) + 32 (market) = 40
    const nextOrderId = new BN(data.subarray(40, 48), "le");
    expect(nextOrderId.toNumber()).to.equal(0);
  });

  it("initializes all 99 price levels as empty", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);

    // Spot-check levels 0, 49 (middle), and 98 (last)
    const levelsToCheck = [0, 49, 98];
    for (const levelIdx of levelsToCheck) {
      // count byte is at the end of the OrderSlot array within each PriceLevel
      // offset = OB_LEVELS_OFFSET + levelIdx * OB_PRICE_LEVEL_SIZE + 32*80
      const countOffset = OB_LEVELS_OFFSET + levelIdx * OB_PRICE_LEVEL_SIZE + 32 * 80;
      const count = data[countOffset];
      expect(count, `level ${levelIdx} count should be 0`).to.equal(0);
    }
  });

  it("stores market pubkey in order book", async () => {
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.orderBook);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);

    // market pubkey: bytes [8..40] (after discriminator)
    const storedMarket = new PublicKey(data.subarray(8, 40));
    expect(storedMarket.toBase58()).to.equal(marketAccounts.market.toBase58());
  });
});
