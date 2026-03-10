import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import BN from "bn.js";
import {
  setupBankrun,
  BankrunContext,
  createMockUsdc,
  initializeConfig,
  initializeOracleFeed,
  createTestMarket,
  MarketAccounts,
  findGlobalConfig,
  findTreasury,
  MOCK_ORACLE_PROGRAM_ID,
  findPriceFeed,
} from "../helpers";
import { BankrunProvider } from "anchor-bankrun";

describe("Escrow Account Setup", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let oracleFeed: PublicKey;
  let marketAccounts: MarketAccounts;
  let config: PublicKey;
  let marketPda: PublicKey;
  const TICKER = "AAPL";
  const STRIKE = 200_000_000;
  const PREVIOUS_CLOSE = 198_000_000;
  let marketCloseUnix: number;

  before(async () => {
    ctx = await setupBankrun();
    usdcMint = await createMockUsdc(ctx.context, ctx.admin);
    config = findGlobalConfig()[0];
    await initializeConfig(
      ctx.context,
      ctx.admin,
      usdcMint,
      MOCK_ORACLE_PROGRAM_ID,
    );
    oracleFeed = await initializeOracleFeed(ctx.context, ctx.admin, TICKER);

    const clock = await ctx.context.banksClient.getClock();
    marketCloseUnix = Number(clock.unixTimestamp) + 86400;

    marketAccounts = await createTestMarket(
      ctx.context,
      ctx.admin,
      config,
      TICKER,
      STRIKE,
      marketCloseUnix,
      PREVIOUS_CLOSE,
      oracleFeed,
      usdcMint,
    );

    marketPda = marketAccounts.market;
  });

  /** Helper: read and decode a token account. */
  async function readTokenAccount(
    address: PublicKey,
  ): Promise<{ mint: PublicKey; owner: PublicKey; amount: bigint }> {
    const acct = await ctx.context.banksClient.getAccount(address);
    expect(acct).to.not.be.null;
    const decoded = AccountLayout.decode(Buffer.from(acct!.data));
    return {
      mint: new PublicKey(decoded.mint),
      owner: new PublicKey(decoded.owner),
      amount: decoded.amount,
    };
  }

  it("creates escrow_vault as USDC token account", async () => {
    const tokenAcct = await readTokenAccount(marketAccounts.escrowVault);

    expect(tokenAcct.mint.toBase58()).to.equal(
      usdcMint.toBase58(),
      "escrow_vault mint should be USDC",
    );
    expect(tokenAcct.owner.toBase58()).to.equal(
      marketPda.toBase58(),
      "escrow_vault owner should be market PDA",
    );
  });

  it("creates yes_escrow as Yes token account", async () => {
    const tokenAcct = await readTokenAccount(marketAccounts.yesEscrow);

    expect(tokenAcct.mint.toBase58()).to.equal(
      marketAccounts.yesMint.toBase58(),
      "yes_escrow mint should be yes_mint",
    );
    expect(tokenAcct.owner.toBase58()).to.equal(
      marketPda.toBase58(),
      "yes_escrow owner should be market PDA",
    );
  });

  it("creates no_escrow as No token account", async () => {
    const tokenAcct = await readTokenAccount(marketAccounts.noEscrow);

    expect(tokenAcct.mint.toBase58()).to.equal(
      marketAccounts.noMint.toBase58(),
      "no_escrow mint should be no_mint",
    );
    expect(tokenAcct.owner.toBase58()).to.equal(
      marketPda.toBase58(),
      "no_escrow owner should be market PDA",
    );
  });

  it("all escrow accounts start with zero balance", async () => {
    const escrowVault = await readTokenAccount(marketAccounts.escrowVault);
    const yesEscrow = await readTokenAccount(marketAccounts.yesEscrow);
    const noEscrow = await readTokenAccount(marketAccounts.noEscrow);

    expect(Number(escrowVault.amount)).to.equal(0, "escrow_vault should start at 0");
    expect(Number(yesEscrow.amount)).to.equal(0, "yes_escrow should start at 0");
    expect(Number(noEscrow.amount)).to.equal(0, "no_escrow should start at 0");
  });

  it("treasury is created with correct config", async () => {
    const [treasury] = findTreasury();
    const tokenAcct = await readTokenAccount(treasury);

    expect(tokenAcct.mint.toBase58()).to.equal(
      usdcMint.toBase58(),
      "treasury mint should be USDC",
    );
    expect(tokenAcct.owner.toBase58()).to.equal(
      config.toBase58(),
      "treasury owner should be config PDA",
    );
  });
});
