import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import {
  setupBankrun,
  BankrunContext,
  createMockUsdc,
  initializeConfig,
  findGlobalConfig,
  findTreasury,
  padTicker,
  MAG7_TICKERS,
  MOCK_ORACLE_PROGRAM_ID,
} from "../helpers";

describe("Config Initialization", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let configPda: PublicKey;
  let treasuryPda: PublicKey;

  before(async () => {
    ctx = await setupBankrun();
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    [configPda] = findGlobalConfig();
    [treasuryPda] = findTreasury();
    await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
  });

  /**
   * Helper: read GlobalConfig account data and return the raw buffer (after 8-byte discriminator).
   *
   * On-chain layout (Borsh order matching config.rs):
   *   admin:                Pubkey  (32)
   *   usdc_mint:            Pubkey  (32)
   *   oracle_program:       Pubkey  (32)
   *   staleness_threshold:  u64 LE  (8)
   *   settlement_staleness: u64 LE  (8)
   *   confidence_bps:       u64 LE  (8)
   *   is_paused:            bool    (1)
   *   oracle_type:          u8      (1)
   *   tickers:              [u8;8]*7 (56)
   *   ticker_count:         u8      (1)
   *   bump:                 u8      (1)
   *   _padding:             [u8;4]  (4)
   *   Total data: 184 bytes (+8 discriminator = 192)
   */
  async function readConfigData(): Promise<Buffer> {
    const acct = await ctx.context.banksClient.getAccount(configPda);
    expect(acct).to.not.be.null;
    return Buffer.from(acct!.data);
  }

  it("initializes global config", async () => {
    const data = await readConfigData();
    const disc = 8;

    // admin pubkey
    const adminKey = new PublicKey(data.subarray(disc, disc + 32));
    expect(adminKey.toBase58()).to.equal(ctx.admin.publicKey.toBase58());

    // usdc_mint
    const mint = new PublicKey(data.subarray(disc + 32, disc + 64));
    expect(mint.toBase58()).to.equal(usdcMint.toBase58());

    // oracle_program
    const oracleProg = new PublicKey(data.subarray(disc + 64, disc + 96));
    expect(oracleProg.toBase58()).to.equal(MOCK_ORACLE_PROGRAM_ID.toBase58());

    // staleness_threshold
    const staleness = data.readBigUInt64LE(disc + 96);
    expect(Number(staleness)).to.equal(60);

    // settlement_staleness
    const settlementStaleness = data.readBigUInt64LE(disc + 104);
    expect(Number(settlementStaleness)).to.equal(120);

    // confidence_bps
    const confidenceBps = data.readBigUInt64LE(disc + 112);
    expect(Number(confidenceBps)).to.equal(50);
  });

  it("stores all 7 tickers correctly", async () => {
    const data = await readConfigData();
    const disc = 8;

    // tickers start at offset disc + 96 (3 pubkeys) + 24 (3 u64s) + 2 (is_paused + oracle_type) = disc + 122
    const tickersOffset = disc + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1; // disc + 122
    for (let i = 0; i < MAG7_TICKERS.length; i++) {
      const storedTicker = data.subarray(tickersOffset + i * 8, tickersOffset + (i + 1) * 8);
      const expected = padTicker(MAG7_TICKERS[i]);
      expect(Buffer.compare(storedTicker, expected)).to.equal(
        0,
        `Ticker at index ${i} should be "${MAG7_TICKERS[i]}"`,
      );
    }

    // ticker_count is at tickersOffset + 56
    const tickerCount = data.readUInt8(tickersOffset + 56);
    expect(tickerCount).to.equal(7);
  });

  it("stores thresholds correctly", async () => {
    const data = await readConfigData();
    const disc = 8;

    const stalenessThreshold = data.readBigUInt64LE(disc + 96);
    const settlementStaleness = data.readBigUInt64LE(disc + 104);
    const confidenceBps = data.readBigUInt64LE(disc + 112);

    expect(Number(stalenessThreshold)).to.equal(60);
    expect(Number(settlementStaleness)).to.equal(120);
    expect(Number(confidenceBps)).to.equal(50);
  });

  it("creates treasury PDA", async () => {
    const acct = await ctx.context.banksClient.getAccount(treasuryPda);
    expect(acct).to.not.be.null;

    // Decode as SPL Token account
    const tokenData = AccountLayout.decode(Buffer.from(acct!.data));

    // Mint should be USDC
    const mintKey = new PublicKey(tokenData.mint);
    expect(mintKey.toBase58()).to.equal(usdcMint.toBase58());

    // Owner (authority) should be the config PDA
    const ownerKey = new PublicKey(tokenData.owner);
    expect(ownerKey.toBase58()).to.equal(configPda.toBase58());

    // Balance should be zero
    expect(Number(tokenData.amount)).to.equal(0);
  });

  it("rejects double initialization", async () => {
    try {
      await initializeConfig(ctx.context, ctx.admin, usdcMint, MOCK_ORACLE_PROGRAM_ID);
      expect.fail("Expected double initialization to fail");
    } catch (err: any) {
      // Anchor/runtime rejects init of an already-initialized PDA account
      const errStr = String(err);
      expect(errStr).to.match(/already in use|0x0|custom program error|failed to send|resulted in an er/i);
    }
  });
});
