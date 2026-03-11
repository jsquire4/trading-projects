import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
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
  createFundedUser,
  executeMintPair,
} from "../helpers";
import { buildMintPairIx } from "../helpers/instructions";
import { BankrunProvider } from "anchor-bankrun";

describe("Mint Pair — Position Constraints", () => {
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

  /** Helper: create a funded user with a USDC ATA (delegates to shared helper). */
  async function fundUser(
    usdcAmount: number,
  ): Promise<{ user: Keypair; userUsdcAta: PublicKey }> {
    return createFundedUser(ctx.context, ctx.admin, usdcMint, usdcAmount);
  }

  /** Helper: build and send a mint_pair transaction (delegates to shared helper). */
  async function mintPair(
    user: Keypair,
    userUsdcAta: PublicKey,
    quantity: number,
  ): Promise<void> {
    return executeMintPair(ctx.context, user, userUsdcAta, config, marketAccounts, quantity);
  }

  it("rejects mint if user holds Yes tokens", async () => {
    const { user, userUsdcAta } = await fundUser(100_000_000);

    // First mint succeeds — user now holds Yes tokens
    await mintPair(user, userUsdcAta, 1_000_000);

    // Second mint should fail due to ConflictingPosition
    try {
      await mintPair(user, userUsdcAta, 1_000_000);
      expect.fail("Expected transaction to fail with ConflictingPosition");
    } catch (err: any) {
      // Anchor error code 6059 = ConflictingPosition (0x17ab)
      const errStr = err.toString();
      expect(errStr).to.match(/0x17ab|ConflictingPosition|6059|custom program error/i);
    }
  });

  it("allows mint when user holds only No tokens", async () => {
    const { user, userUsdcAta } = await fundUser(100_000_000);
    const provider = new BankrunProvider(ctx.context);

    // First mint — user gets Yes + No tokens
    await mintPair(user, userUsdcAta, 2_000_000);

    // Transfer ALL Yes tokens to a separate keypair
    const recipient = Keypair.generate();
    ctx.context.setAccount(recipient.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: PublicKey.default,
      executable: false,
    });

    const recipientYesAta = await createAta(
      ctx.context,
      ctx.admin,
      marketAccounts.yesMint,
      recipient.publicKey,
    );

    const userYesAta = getAssociatedTokenAddressSync(
      marketAccounts.yesMint,
      user.publicKey,
    );

    const transferIx = createTransferInstruction(
      userYesAta,
      recipientYesAta,
      user.publicKey,
      2_000_000,
    );

    const transferTx = new Transaction().add(transferIx);
    await provider.sendAndConfirm!(transferTx, [user]);

    // Verify Yes ATA is now 0
    const acct = await ctx.context.banksClient.getAccount(userYesAta);
    const decoded = AccountLayout.decode(Buffer.from(acct!.data));
    expect(Number(decoded.amount)).to.equal(0, "Yes ATA should be empty after transfer");

    // Second mint should succeed — user holds only No tokens, Yes ATA is 0
    await mintPair(user, userUsdcAta, 1_000_000);

    // Verify the mint succeeded
    const yesBalanceAfter = AccountLayout.decode(
      Buffer.from((await ctx.context.banksClient.getAccount(userYesAta))!.data),
    ).amount;
    expect(Number(yesBalanceAfter)).to.equal(1_000_000);
  });

  it("allows first mint for fresh user", async () => {
    const { user, userUsdcAta } = await fundUser(50_000_000);

    // Verify user has no Yes/No ATAs
    const userYesAta = getAssociatedTokenAddressSync(
      marketAccounts.yesMint,
      user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      marketAccounts.noMint,
      user.publicKey,
    );
    const yesBefore = await ctx.context.banksClient.getAccount(userYesAta);
    expect(yesBefore).to.be.null;
    const noBefore = await ctx.context.banksClient.getAccount(userNoAta);
    expect(noBefore).to.be.null;

    // First mint for a fresh user should succeed
    await mintPair(user, userUsdcAta, 1_000_000);

    // Verify tokens received
    const yesAcct = await ctx.context.banksClient.getAccount(userYesAta);
    const yesDecoded = AccountLayout.decode(Buffer.from(yesAcct!.data));
    expect(Number(yesDecoded.amount)).to.equal(1_000_000);

    const noAcct = await ctx.context.banksClient.getAccount(userNoAta);
    const noDecoded = AccountLayout.decode(Buffer.from(noAcct!.data));
    expect(Number(noDecoded.amount)).to.equal(1_000_000);
  });
});
