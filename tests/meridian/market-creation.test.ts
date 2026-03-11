import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
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
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  MOCK_ORACLE_PROGRAM_ID,
} from "../helpers";

describe("Market Creation", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let config: PublicKey;
  let oracleFeed: PublicKey;
  let marketAccounts: MarketAccounts;

  const TICKER = "AAPL";
  const STRIKE_PRICE = 200_000_000; // $200.00
  const PREVIOUS_CLOSE = 195_000_000; // $195.00
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
    await updateOraclePrice(ctx.context, ctx.admin, oracleFeed, 198_000_000, 500_000);

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

  it("creates a strike market with all PDAs", async () => {
    const strikePriceBN = new BN(STRIKE_PRICE);
    const [expectedMarket] = findStrikeMarket(TICKER, strikePriceBN, MARKET_CLOSE_UNIX);
    expect(marketAccounts.market.toBase58()).to.equal(expectedMarket.toBase58());

    // Fetch the market account data
    const acctInfo = await ctx.context.banksClient.getAccount(marketAccounts.market);
    expect(acctInfo).to.not.be.null;
    const data = Buffer.from(acctInfo!.data);

    // Skip 8-byte discriminator, then read fields in order
    let offset = 8;

    // config (Pubkey, 32 bytes)
    const configKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(configKey.toBase58()).to.equal(config.toBase58());
    offset += 32;

    // yes_mint (Pubkey, 32 bytes)
    const yesMintKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(yesMintKey.toBase58()).to.equal(marketAccounts.yesMint.toBase58());
    offset += 32;

    // no_mint (Pubkey, 32 bytes)
    const noMintKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(noMintKey.toBase58()).to.equal(marketAccounts.noMint.toBase58());
    offset += 32;

    // usdc_vault (Pubkey, 32 bytes)
    const usdcVaultKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(usdcVaultKey.toBase58()).to.equal(marketAccounts.usdcVault.toBase58());
    offset += 32;

    // escrow_vault (Pubkey, 32 bytes)
    const escrowVaultKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(escrowVaultKey.toBase58()).to.equal(marketAccounts.escrowVault.toBase58());
    offset += 32;

    // yes_escrow (Pubkey, 32 bytes)
    const yesEscrowKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(yesEscrowKey.toBase58()).to.equal(marketAccounts.yesEscrow.toBase58());
    offset += 32;

    // no_escrow (Pubkey, 32 bytes)
    const noEscrowKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(noEscrowKey.toBase58()).to.equal(marketAccounts.noEscrow.toBase58());
    offset += 32;

    // order_book (Pubkey, 32 bytes)
    const orderBookKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(orderBookKey.toBase58()).to.equal(marketAccounts.orderBook.toBase58());
    offset += 32;

    // oracle_feed (Pubkey, 32 bytes)
    const oracleFeedKey = new PublicKey(data.subarray(offset, offset + 32));
    expect(oracleFeedKey.toBase58()).to.equal(oracleFeed.toBase58());
    offset += 32;

    // strike_price (u64, 8 bytes LE)
    const strikePriceVal = new BN(data.subarray(offset, offset + 8), "le");
    expect(strikePriceVal.toNumber()).to.equal(STRIKE_PRICE);
    offset += 8;

    // market_close_unix (i64, 8 bytes LE)
    const marketCloseVal = new BN(data.subarray(offset, offset + 8), "le");
    expect(marketCloseVal.toNumber()).to.equal(MARKET_CLOSE_UNIX);
    offset += 8;
  });

  it("creates yes and no mints with correct authority", async () => {
    // Yes mint
    const yesMintAcct = await ctx.context.banksClient.getAccount(marketAccounts.yesMint);
    expect(yesMintAcct).to.not.be.null;
    const yesData = Buffer.from(yesMintAcct!.data);
    // SPL Mint layout: mint_authority option (4 + 32 = 36 bytes at offset 0)
    // option discriminator (4 bytes: 1 = Some), then 32-byte pubkey
    const yesMintAuthOption = yesData.readUInt32LE(0);
    expect(yesMintAuthOption).to.equal(1); // Some
    const yesMintAuth = new PublicKey(yesData.subarray(4, 36));
    expect(yesMintAuth.toBase58()).to.equal(marketAccounts.market.toBase58());
    // decimals at offset 44
    const yesDecimals = yesData[44];
    expect(yesDecimals).to.equal(6);

    // No mint
    const noMintAcct = await ctx.context.banksClient.getAccount(marketAccounts.noMint);
    expect(noMintAcct).to.not.be.null;
    const noData = Buffer.from(noMintAcct!.data);
    const noMintAuthOption = noData.readUInt32LE(0);
    expect(noMintAuthOption).to.equal(1); // Some
    const noMintAuth = new PublicKey(noData.subarray(4, 36));
    expect(noMintAuth.toBase58()).to.equal(marketAccounts.market.toBase58());
    const noDecimals = noData[44];
    expect(noDecimals).to.equal(6);
  });

  it("creates USDC vault with correct ownership", async () => {
    const vaultAcct = await ctx.context.banksClient.getAccount(marketAccounts.usdcVault);
    expect(vaultAcct).to.not.be.null;
    const vaultData = Buffer.from(vaultAcct!.data);

    // SPL TokenAccount layout:
    //   mint (32 bytes at offset 0)
    //   owner (32 bytes at offset 32)
    const vaultMint = new PublicKey(vaultData.subarray(0, 32));
    expect(vaultMint.toBase58()).to.equal(usdcMint.toBase58());

    const vaultOwner = new PublicKey(vaultData.subarray(32, 64));
    expect(vaultOwner.toBase58()).to.equal(marketAccounts.market.toBase58());
  });

  it("rejects duplicate market creation", async () => {
    try {
      await createTestMarket(
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
      expect.fail("Expected duplicate market creation to fail");
    } catch (err: any) {
      // Anchor/runtime rejects init of an already-initialized PDA account
      const errStr = String(err);
      expect(errStr).to.match(/already in use|0x0|custom program error/i);
    }
  });

  it("rejects invalid ticker", async () => {
    const badTicker = "INVALID";
    // Need a different strike/close so the PDA is fresh, but the ticker check
    // should fail before the init constraint matters.
    const badCloseUnix = MARKET_CLOSE_UNIX + 86400;
    const badStrike = 300_000_000;

    // We still need an oracle feed for the instruction — reuse existing one.
    // The ticker validation happens first in the handler.
    try {
      await createTestMarket(
        ctx.context,
        ctx.admin,
        config,
        badTicker,
        badStrike,
        badCloseUnix,
        PREVIOUS_CLOSE,
        oracleFeed,
        usdcMint,
      );
      expect.fail("Expected invalid ticker to be rejected");
    } catch (err: any) {
      // Error code 6012 = InvalidTicker
      const errStr = String(err);
      expect(errStr).to.match(/6012|InvalidTicker|custom program error/i);
    }
  });
});
