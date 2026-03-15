import { expect } from "chai";
import { Keypair, Transaction, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  setupBankrun,
  BankrunContext,
  initializeOracleFeed,
  findPriceFeed,
  padTicker,
  buildUpdatePriceIx,
  MOCK_ORACLE_PROGRAM_ID,
} from "../helpers";
import { BankrunProvider } from "anchor-bankrun";

describe("Oracle CRUD", () => {
  let ctx: BankrunContext;
  let provider: BankrunProvider;

  before(async () => {
    ctx = await setupBankrun();
    provider = new BankrunProvider(ctx.context);
  });

  it("initializes a price feed", async () => {
    const ticker = "AAPL";
    const pda = await initializeOracleFeed(ctx.context, ctx.admin, ticker);

    const [expectedPda] = findPriceFeed(ticker);
    expect(pda.toBase58()).to.equal(expectedPda.toBase58());

    // Read account and verify ticker bytes
    const acct = await ctx.context.banksClient.getAccount(pda);
    expect(acct).to.not.be.null;

    const data = Buffer.from(acct!.data);
    // Skip 8-byte Anchor discriminator, then ticker is first 8 bytes
    const tickerBytes = data.subarray(8, 16);
    const expectedTicker = padTicker(ticker);
    expect(Buffer.compare(tickerBytes, expectedTicker)).to.equal(0);
  });

  it("updates price", async () => {
    const ticker = "MSFT";
    const pda = await initializeOracleFeed(ctx.context, ctx.admin, ticker);

    const price = 200_000_000;
    const confidence = 500_000;

    // Get current clock for timestamp
    const clock = await ctx.context.banksClient.getClock();
    const timestamp = Number(clock.unixTimestamp);


    const ix = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed: pda,
      price: new BN(price),
      confidence: new BN(confidence),
      timestamp: new BN(timestamp),
    });
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm!(tx, [ctx.admin]);

    // Read account and decode fields after 8-byte discriminator
    // Layout: ticker(8) + price(u64 LE 8) + confidence(u64 LE 8) + timestamp(i64 LE 8) + authority(32) + is_initialized(1) + bump(1) + padding(6)
    const acct = await ctx.context.banksClient.getAccount(pda);
    expect(acct).to.not.be.null;
    const data = Buffer.from(acct!.data);

    const storedPrice = data.readBigUInt64LE(16);   // offset 8 (disc) + 8 (ticker)
    const storedConf = data.readBigUInt64LE(24);     // offset 8 + 8 + 8
    const storedTs = data.readBigInt64LE(32);        // offset 8 + 8 + 8 + 8

    expect(Number(storedPrice)).to.equal(price);
    expect(Number(storedConf)).to.equal(confidence);
    expect(Number(storedTs)).to.equal(timestamp);
  });

  it("rejects update from non-authority", async () => {
    const ticker = "GOOGL";
    const pda = await initializeOracleFeed(ctx.context, ctx.admin, ticker);

    // Create a second keypair that is NOT the authority
    const imposter = Keypair.generate();

    // Fund the imposter so it can sign transactions

    const clock = await ctx.context.banksClient.getClock();
    const timestamp = Number(clock.unixTimestamp);

    const ix = buildUpdatePriceIx({
      authority: imposter.publicKey,
      priceFeed: pda,
      price: new BN(100_000_000),
      confidence: new BN(100_000),
      timestamp: new BN(timestamp),
    });
    const tx = new Transaction().add(ix);

    try {
      await provider.sendAndConfirm!(tx, [imposter]);
      expect.fail("Expected transaction to fail with InvalidAuthority");
    } catch (err: any) {
      // Anchor error code 6000 = InvalidAuthority (0x1770)
      const errStr = err.toString();
      expect(errStr).to.contain("0x1770");
    }
  });

  it("rejects zero price", async () => {
    const ticker = "AMZN";
    const pda = await initializeOracleFeed(ctx.context, ctx.admin, ticker);

    const clock = await ctx.context.banksClient.getClock();
    const timestamp = Number(clock.unixTimestamp);


    const ix = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed: pda,
      price: new BN(0),
      confidence: new BN(100_000),
      timestamp: new BN(timestamp),
    });
    const tx = new Transaction().add(ix);

    try {
      await provider.sendAndConfirm!(tx, [ctx.admin]);
      expect.fail("Expected transaction to fail with InvalidPrice");
    } catch (err: any) {
      // Anchor error code 6002 = InvalidPrice (0x1772)
      const errStr = err.toString();
      expect(errStr).to.contain("0x1772");
    }
  });

  it("rejects zero timestamp", async () => {
    const ticker = "NVDA";
    const pda = await initializeOracleFeed(ctx.context, ctx.admin, ticker);


    const ix = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed: pda,
      price: new BN(150_000_000),
      confidence: new BN(100_000),
      timestamp: new BN(0),
    });
    const tx = new Transaction().add(ix);

    try {
      await provider.sendAndConfirm!(tx, [ctx.admin]);
      expect.fail("Expected transaction to fail with InvalidTimestamp");
    } catch (err: any) {
      // Anchor error code 6003 = InvalidTimestamp (0x1773)
      const errStr = err.toString();
      expect(errStr).to.contain("0x1773");
    }
  });
});
