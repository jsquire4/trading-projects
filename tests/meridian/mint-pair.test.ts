import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  AccountLayout,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  setupBankrun,
  BankrunContext,
  createMockUsdc,
  initializeConfig,
  initializeOracleFeed,
  createTestMarket,
  mintTestUsdc,
  createAta,
  MarketAccounts,
  findGlobalConfig,
  MOCK_ORACLE_PROGRAM_ID,
} from "../helpers";
import { buildMintPairIx } from "../helpers/instructions";
import { BankrunProvider } from "anchor-bankrun";

describe("Mint Pair", () => {
  let ctx: BankrunContext;
  let usdcMint: PublicKey;
  let oracleFeed: PublicKey;
  let marketAccounts: MarketAccounts;
  let config: PublicKey;
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
  });

  /** Helper: create a funded user with a USDC ATA. */
  async function createFundedUser(
    usdcAmount: number,
  ): Promise<{ user: Keypair; userUsdcAta: PublicKey }> {
    const user = Keypair.generate();

    // Fund the user with SOL via context
    ctx.context.setAccount(user.publicKey, {
      lamports: 10_000_000_000, // 10 SOL
      data: Buffer.alloc(0),
      owner: PublicKey.default,
      executable: false,
    });

    // Create USDC ATA for user (raw instruction for bankrun compatibility)
    const userUsdcAta = await createAta(
      ctx.context,
      ctx.admin,
      usdcMint,
      user.publicKey,
    );

    if (usdcAmount > 0) {
      await mintTestUsdc(
        ctx.context,
        usdcMint,
        ctx.admin,
        userUsdcAta,
        usdcAmount,
      );
    }

    return { user, userUsdcAta };
  }

  /** Helper: build and send a mint_pair transaction. */
  async function executeMintPair(
    user: Keypair,
    userUsdcAta: PublicKey,
    quantity: number,
  ): Promise<void> {
    const provider = new BankrunProvider(ctx.context);
    const userYesAta = getAssociatedTokenAddressSync(
      marketAccounts.yesMint,
      user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      marketAccounts.noMint,
      user.publicKey,
    );

    const ix = buildMintPairIx({
      user: user.publicKey,
      config,
      market: marketAccounts.market,
      yesMint: marketAccounts.yesMint,
      noMint: marketAccounts.noMint,
      userUsdcAta,
      userYesAta,
      userNoAta,
      usdcVault: marketAccounts.usdcVault,
      quantity: new BN(quantity),
    });

    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm!(tx, [user]);
  }

  /** Helper: read a token account balance. */
  async function getTokenBalance(address: PublicKey): Promise<bigint> {
    const acct = await ctx.context.banksClient.getAccount(address);
    expect(acct).to.not.be.null;
    const decoded = AccountLayout.decode(Buffer.from(acct!.data));
    return decoded.amount;
  }

  /** Helper: read total_minted from the market account. */
  async function getTotalMinted(): Promise<bigint> {
    const acct = await ctx.context.banksClient.getAccount(
      marketAccounts.market,
    );
    expect(acct).to.not.be.null;
    const data = Buffer.from(acct!.data);
    // Anchor disc(8) + 9 Pubkeys(288) + strike_price(8) + market_close_unix(8) = offset 312
    return data.readBigUInt64LE(312);
  }

  it("mints a yes/no pair and deposits USDC to vault", async () => {
    const quantity = 5_000_000; // 5 tokens
    const initialUsdc = 100_000_000; // 100 USDC
    const { user, userUsdcAta } = await createFundedUser(initialUsdc);

    const vaultBefore = await getTokenBalance(marketAccounts.usdcVault);
    const totalMintedBefore = await getTotalMinted();

    await executeMintPair(user, userUsdcAta, quantity);

    const userYesAta = getAssociatedTokenAddressSync(
      marketAccounts.yesMint,
      user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      marketAccounts.noMint,
      user.publicKey,
    );

    const yesBalance = await getTokenBalance(userYesAta);
    expect(Number(yesBalance)).to.equal(quantity, "user_yes_ata should have 5_000_000 tokens");

    const noBalance = await getTokenBalance(userNoAta);
    expect(Number(noBalance)).to.equal(quantity, "user_no_ata should have 5_000_000 tokens");

    const vaultAfter = await getTokenBalance(marketAccounts.usdcVault);
    expect(Number(vaultAfter) - Number(vaultBefore)).to.equal(
      quantity,
      "usdc_vault should increase by 5_000_000",
    );

    const usdcBalance = await getTokenBalance(userUsdcAta);
    expect(Number(usdcBalance)).to.equal(
      initialUsdc - quantity,
      "user_usdc_ata should decrease by 5_000_000",
    );

    const totalMintedAfter = await getTotalMinted();
    expect(Number(totalMintedAfter) - Number(totalMintedBefore)).to.equal(
      quantity,
      "market.total_minted should increase by 5_000_000",
    );
  });

  it("maintains vault balance invariant", async () => {
    // Use a fresh market to get a clean total_minted baseline
    const feed2 = await initializeOracleFeed(ctx.context, ctx.admin, "MSFT");
    const clock = await ctx.context.banksClient.getClock();
    const closeUnix2 = Number(clock.unixTimestamp) + 86400;
    const ma2 = await createTestMarket(
      ctx.context,
      ctx.admin,
      config,
      "MSFT",
      250_000_000,
      closeUnix2,
      248_000_000,
      feed2,
      usdcMint,
    );

    const { user, userUsdcAta } = await createFundedUser(500_000_000);

    const amounts = [3_000_000, 7_000_000, 2_000_000];
    let cumulativeMinted = 0;

    for (const amount of amounts) {
      // Each mint needs the user's Yes ATA to be 0 — position constraint.
      // For the first mint, ATA doesn't exist yet (init_if_needed handles it).
      // For subsequent mints, the user already holds Yes tokens, so we need
      // a fresh user each time OR transfer tokens away.
      // Since the position constraint blocks re-minting, use a fresh user per mint.
    }

    // Use separate users for each mint to satisfy position constraint
    let totalVaulted = 0;
    for (const amount of amounts) {
      const minter = await createFundedUser(amount * 2);
      const provider = new BankrunProvider(ctx.context);
      const userYesAta = getAssociatedTokenAddressSync(
        ma2.yesMint,
        minter.user.publicKey,
      );
      const userNoAta = getAssociatedTokenAddressSync(
        ma2.noMint,
        minter.user.publicKey,
      );

      const ix = buildMintPairIx({
        user: minter.user.publicKey,
        config,
        market: ma2.market,
        yesMint: ma2.yesMint,
        noMint: ma2.noMint,
        userUsdcAta: minter.userUsdcAta,
        userYesAta,
        userNoAta,
        usdcVault: ma2.usdcVault,
        quantity: new BN(amount),
      });

      const tx = new Transaction().add(ix);
      await provider.sendAndConfirm!(tx, [minter.user]);
      totalVaulted += amount;
    }

    const vaultBalance = await getTokenBalance(ma2.usdcVault);
    const acct = await ctx.context.banksClient.getAccount(ma2.market);
    const data = Buffer.from(acct!.data);
    const totalMinted = Number(data.readBigUInt64LE(312));

    expect(Number(vaultBalance)).to.equal(totalMinted, "vault balance should equal total_minted");
    expect(totalMinted).to.equal(totalVaulted, "total_minted should equal sum of all mints");
  });

  it("creates ATAs via init_if_needed", async () => {
    // Fresh user with no existing Yes/No ATAs — mint_pair should create them
    const { user, userUsdcAta } = await createFundedUser(50_000_000);

    const userYesAta = getAssociatedTokenAddressSync(
      marketAccounts.yesMint,
      user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      marketAccounts.noMint,
      user.publicKey,
    );

    // Verify ATAs don't exist yet
    const yesBefore = await ctx.context.banksClient.getAccount(userYesAta);
    expect(yesBefore).to.be.null;
    const noBefore = await ctx.context.banksClient.getAccount(userNoAta);
    expect(noBefore).to.be.null;

    // Mint pair — should create both ATAs automatically
    await executeMintPair(user, userUsdcAta, 1_000_000);

    // Verify ATAs now exist with tokens
    const yesAfter = await getTokenBalance(userYesAta);
    expect(Number(yesAfter)).to.equal(1_000_000);
    const noAfter = await getTokenBalance(userNoAta);
    expect(Number(noAfter)).to.equal(1_000_000);
  });

  it("rejects quantity below minimum", async () => {
    const { user, userUsdcAta } = await createFundedUser(50_000_000);

    try {
      await executeMintPair(user, userUsdcAta, 999_999);
      expect.fail("Expected transaction to fail with InvalidQuantity");
    } catch (err: any) {
      // Anchor error code 6053 = InvalidQuantity (0x17a5)
      const errStr = err.toString();
      expect(errStr).to.contain("0x17a5");
    }
  });

  it("rejects insufficient USDC balance", async () => {
    const { user, userUsdcAta } = await createFundedUser(0); // zero USDC

    try {
      await executeMintPair(user, userUsdcAta, 1_000_000);
      expect.fail("Expected transaction to fail with InsufficientBalance");
    } catch (err: any) {
      // Anchor error code 6050 = InsufficientBalance (0x17a2)
      const errStr = err.toString();
      expect(errStr).to.contain("0x17a2");
    }
  });

  it("yes supply equals no supply", async () => {
    const { user, userUsdcAta } = await createFundedUser(50_000_000);
    await executeMintPair(user, userUsdcAta, 3_000_000);

    // Read mint supply from the mint accounts
    const yesMintAcct = await ctx.context.banksClient.getAccount(
      marketAccounts.yesMint,
    );
    const noMintAcct = await ctx.context.banksClient.getAccount(
      marketAccounts.noMint,
    );
    expect(yesMintAcct).to.not.be.null;
    expect(noMintAcct).to.not.be.null;

    // Mint layout: supply is at offset 36 (4 bytes mint_authority_option + 32 bytes mint_authority = 36, then supply u64 LE)
    const yesData = Buffer.from(yesMintAcct!.data);
    const noData = Buffer.from(noMintAcct!.data);
    const yesSupply = yesData.readBigUInt64LE(36);
    const noSupply = noData.readBigUInt64LE(36);

    expect(yesSupply).to.equal(noSupply, "yes_mint supply should equal no_mint supply");
  });
});
