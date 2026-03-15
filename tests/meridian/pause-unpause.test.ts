import { expect } from "chai";
import { PublicKey, Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";

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
} from "../helpers";

import {
  buildPauseIx,
  buildUnpauseIx,
} from "../helpers/instructions";

describe("Pause / Unpause", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;
  let ma: MarketAccounts;
  let provider: BankrunProvider;

  const TICKER = "TSLA";
  const STRIKE_PRICE = 300_000_000;
  const PREVIOUS_CLOSE = 290_000_000;
  let marketCloseUnix: number;

  before(async () => {
    ctx = await setupBankrun();
    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 295_000_000, 500_000);

    ma = await createTestMarket(
      ctx.context, ctx.admin, config, TICKER,
      STRIKE_PRICE, marketCloseUnix, PREVIOUS_CLOSE,
      oracleFeed, usdcMint,
    );

    provider = new BankrunProvider(ctx.context);
  });

  it("pauses globally", async () => {

    const ix = buildPauseIx({ admin: ctx.admin.publicKey, config });
    await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);

    // Read config to verify is_paused = true
    const configAcct = await ctx.context.banksClient.getAccount(config);
    const data = Buffer.from(configAcct!.data);
    // is_paused is after: disc(8) + admin(32) + usdc_mint(32) + oracle_program(32)
    //                     + staleness(8) + settlement_staleness(8) + confidence_bps(8)
    // = 8 + 32 + 32 + 32 + 8 + 8 + 8 = 128
    const isPaused = data[128] !== 0;
    expect(isPaused).to.be.true;
  });

  it("rejects double pause", async () => {

    const ix = buildPauseIx({ admin: ctx.admin.publicKey, config });
    // Add unique compute budget to avoid duplicate tx hash
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 199_999 }),
      ix,
    );

    try {
      await provider.sendAndConfirm!(tx, [ctx.admin]);
      expect.fail("Expected AlreadyPaused error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x1787|AlreadyPaused|6023/i);
    }
  });

  it("unpauses globally", async () => {

    const ix = buildUnpauseIx({ admin: ctx.admin.publicKey, config });
    await provider.sendAndConfirm!(new Transaction().add(ix), [ctx.admin]);

    const configAcct = await ctx.context.banksClient.getAccount(config);
    const data = Buffer.from(configAcct!.data);
    const isPaused = data[128] !== 0;
    expect(isPaused).to.be.false;
  });

  it("rejects unpause when not paused", async () => {

    const ix = buildUnpauseIx({ admin: ctx.admin.publicKey, config });
    // Add unique compute budget to avoid duplicate tx hash
    const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 199_998 });

    try {
      await provider.sendAndConfirm!(new Transaction().add(budgetIx, ix), [ctx.admin]);
      expect.fail("Expected NotPaused error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x1788|NotPaused|6024/i);
    }
  });

  it("rejects pause from non-admin", async () => {

    const nonAdmin = Keypair.generate();
    ctx.context.setAccount(nonAdmin.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      executable: false,
    });

    const ix = buildPauseIx({ admin: nonAdmin.publicKey, config });

    try {
      await provider.sendAndConfirm!(new Transaction().add(ix), [nonAdmin]);
      expect.fail("Expected Unauthorized error");
    } catch (err: any) {
      expect(String(err)).to.match(/0x1770|Unauthorized|6000|has_one/i);
    }
  });

  // Per-market pause test removed — only global pause is supported now.
});
