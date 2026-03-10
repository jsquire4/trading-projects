import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
  MarketAccounts,
  findGlobalConfig,
  MOCK_ORACLE_PROGRAM_ID,
} from "../helpers";
import { buildSetMarketAltIx } from "../helpers/instructions";

/**
 * StrikeMarket layout — alt_address offset:
 *   8 (discriminator)
 * + 9 * 32 (Pubkeys: config, yes_mint, no_mint, usdc_vault, escrow_vault,
 *           yes_escrow, no_escrow, order_book, oracle_feed) = 288
 * + 8 * 8 (u64/i64: strike_price, market_close_unix, total_minted,
 *          total_redeemed, settlement_price, previous_close, settled_at,
 *          override_deadline) = 64
 * = 360
 *
 * alt_address is a Pubkey (32 bytes) at offset 360.
 */
const ALT_ADDRESS_OFFSET = 8 + 9 * 32 + 8 * 8; // 360

describe("set_market_alt", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;
  let marketAccounts: MarketAccounts;

  const TICKER = "GOOGL";
  const STRIKE_PRICE = 150_000_000;
  const PREVIOUS_CLOSE = 148_000_000;
  const MARKET_CLOSE_UNIX = Math.floor(Date.now() / 1000) + 86400 * 30;

  before(async () => {
    ctx = await setupBankrun();
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
    [config] = findGlobalConfig();
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 149_000_000, 500_000);

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

  it("sets ALT address on market", async () => {
    const altPubkey = Keypair.generate().publicKey;
    const provider = new BankrunProvider(ctx.context);

    const ix = buildSetMarketAltIx({
      admin: ctx.admin.publicKey,
      config,
      market: marketAccounts.market,
      altAddress: altPubkey,
    });

    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm!(tx, [ctx.admin]);

    // Read back the market account and verify alt_address
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.market);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);
    const storedAlt = new PublicKey(data.subarray(ALT_ADDRESS_OFFSET, ALT_ADDRESS_OFFSET + 32));
    expect(storedAlt.toBase58()).to.equal(altPubkey.toBase58());
  });

  it("rejects if ALT already set", async () => {
    // ALT was already set in the previous test, so setting again should fail
    const anotherAlt = Keypair.generate().publicKey;
    const provider = new BankrunProvider(ctx.context);

    const ix = buildSetMarketAltIx({
      admin: ctx.admin.publicKey,
      config,
      market: marketAccounts.market,
      altAddress: anotherAlt,
    });

    const tx = new Transaction().add(ix);

    try {
      await provider.sendAndConfirm!(tx, [ctx.admin]);
      expect.fail("Expected AltAlreadySet error");
    } catch (err: any) {
      // Error code 6120 = AltAlreadySet
      const errStr = String(err);
      expect(errStr).to.match(/0x17e8|6120|AltAlreadySet/i);
    }
  });

  it("rejects non-admin caller", async () => {
    // Create a fresh market so ALT is not yet set
    const freshTicker = "NVDA";
    const freshOracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, freshTicker);
    await updateOraclePrice(ctx.context, ctx.admin, freshOracleFeed, 800_000_000, 1_000_000);

    const freshCloseUnix = MARKET_CLOSE_UNIX + 86400;
    const freshAccounts = await createTestMarket(
      ctx.context,
      ctx.admin,
      config,
      freshTicker,
      500_000_000,
      freshCloseUnix,
      490_000_000,
      freshOracleFeed,
      usdcMint,
    );

    // Create a non-admin keypair and fund it via bankrun
    const nonAdmin = Keypair.generate();
    const provider = new BankrunProvider(ctx.context);

    // Fund the non-admin account with SOL so it can sign transactions
    ctx.context.setAccount(nonAdmin.publicKey, {
      lamports: 1_000_000_000, // 1 SOL
      data: Buffer.alloc(0),
      owner: PublicKey.default,
      executable: false,
    });

    const altPubkey = Keypair.generate().publicKey;

    const ix = buildSetMarketAltIx({
      admin: nonAdmin.publicKey,
      config,
      market: freshAccounts.market,
      altAddress: altPubkey,
    });

    const tx = new Transaction().add(ix);

    try {
      await provider.sendAndConfirm!(tx, [nonAdmin]);
      expect.fail("Expected Unauthorized error");
    } catch (err: any) {
      // Error code 6000 = Unauthorized (has_one = admin check fails)
      const errStr = String(err);
      expect(errStr).to.match(/0x1770|6000|Unauthorized|has_one/i);
    }
  });
});
