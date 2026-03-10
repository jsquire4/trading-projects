/**
 * setup.ts — Shared test setup utilities for the Meridian bankrun test suite.
 *
 * Uses solana-bankrun to spin up a local validator with both programs loaded,
 * and anchor-bankrun's BankrunProvider for Anchor compatibility.
 *
 * Since no IDLs are generated yet, all instructions are built manually via
 * the helpers in ./instructions.ts.
 */

import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";
import { start, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import BN from "bn.js";

import {
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
  padTicker,
  buildInitializeConfigIx,
  buildCreateStrikeMarketIx,
  buildInitializeFeedIx,
  buildUpdatePriceIx,
} from "./instructions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

export { MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BankrunContext {
  context: ProgramTestContext;
  provider: BankrunProvider;
  admin: Keypair;
}

export interface MarketAccounts {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
}

// ---------------------------------------------------------------------------
// PDA derivation helpers (duplicated from pda.ts for test isolation)
// ---------------------------------------------------------------------------

export function findGlobalConfig(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findTreasury(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findStrikeMarket(
  ticker: string,
  strikePriceLamports: BN,
  marketCloseUnix: number,
): [PublicKey, number] {
  const expiryDay = Math.floor(marketCloseUnix / 86400);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      padTicker(ticker),
      strikePriceLamports.toArrayLike(Buffer, "le", 8),
      new BN(expiryDay).toArrayLike(Buffer, "le", 4),
    ],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findYesMint(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findNoMint(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findUsdcVault(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findEscrowVault(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findYesEscrow(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findNoEscrow(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("no_escrow"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findOrderBook(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order_book"), market.toBuffer()],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findPriceFeed(ticker: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), padTicker(ticker)],
    MOCK_ORACLE_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Bankrun bootstrap
// ---------------------------------------------------------------------------

/**
 * Start a bankrun instance with both Meridian and MockOracle programs loaded.
 *
 * The `start()` function locates .so binaries from `target/deploy/` by program
 * name automatically (e.g. "meridian" -> target/deploy/meridian.so).
 *
 * Returns the bankrun context, an Anchor-compatible provider, and the admin
 * keypair (which is also the fee payer).
 */
export async function setupBankrun(): Promise<BankrunContext> {
  const context = await start(
    [
      { name: "meridian", programId: MERIDIAN_PROGRAM_ID },
      { name: "mock_oracle", programId: MOCK_ORACLE_PROGRAM_ID },
    ],
    [],
  );

  const provider = new BankrunProvider(context);
  const admin = context.payer;

  return { context, provider, admin };
}

// ---------------------------------------------------------------------------
// Transaction sending helper
// ---------------------------------------------------------------------------

/**
 * Send and confirm a transaction via BankrunProvider.
 * The provider handles recentBlockhash assignment and wallet signing
 * internally, so callers only need to pass the unsigned transaction and
 * any additional signers.
 */
async function sendTx(
  provider: BankrunProvider,
  tx: Transaction,
  signers: Keypair[] = [],
): Promise<string> {
  // BankrunProvider.sendAndConfirm is typed as optional in the .d.ts but
  // is always present at runtime. The non-null assertion is safe here.
  return provider.sendAndConfirm!(tx, signers);
}

// ---------------------------------------------------------------------------
// Mock USDC creation
// ---------------------------------------------------------------------------

/**
 * Create a mock USDC SPL token mint with 6 decimals.
 * Uses raw instructions instead of @solana/spl-token's createMint()
 * because bankrun's connection proxy doesn't support sendTransaction.
 */
export async function createMockUsdc(
  context: ProgramTestContext,
  admin: Keypair,
): Promise<PublicKey> {
  const provider = new BankrunProvider(context);
  const mintKeypair = Keypair.generate();

  const rent = await context.banksClient.getRent();
  const lamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      6,                // decimals
      admin.publicKey,  // mint authority
      admin.publicKey,  // freeze authority
    ),
  );

  await sendTx(provider, tx, [admin, mintKeypair]);

  return mintKeypair.publicKey;
}

// ---------------------------------------------------------------------------
// Initialize GlobalConfig
// ---------------------------------------------------------------------------

/**
 * Call initialize_config on the Meridian program with MAG7 tickers.
 */
export async function initializeConfig(
  context: ProgramTestContext,
  admin: Keypair,
  usdcMint: PublicKey,
  oracleProgram: PublicKey,
): Promise<void> {
  const provider = new BankrunProvider(context);

  const [config] = findGlobalConfig();
  const [treasury] = findTreasury();

  const ix = buildInitializeConfigIx({
    admin: admin.publicKey,
    config,
    usdcMint,
    treasury,
    oracleProgram,
    tickers: MAG7_TICKERS,
    tickerCount: MAG7_TICKERS.length,
    stalenessThreshold: 60,
    settlementStaleness: 120,
    confidenceBps: 50,
    oracleType: 0, // Mock
  });

  const tx = new Transaction().add(ix);
  await sendTx(provider, tx, [admin]);
}

// ---------------------------------------------------------------------------
// Initialize oracle feed
// ---------------------------------------------------------------------------

/**
 * Initialize a PriceFeed account on the MockOracle program.
 * Returns the PDA of the initialized feed.
 */
export async function initializeOracleFeed(
  context: ProgramTestContext,
  admin: Keypair,
  ticker: string,
): Promise<PublicKey> {
  const provider = new BankrunProvider(context);

  const [priceFeed] = findPriceFeed(ticker);

  const ix = buildInitializeFeedIx({
    authority: admin.publicKey,
    priceFeed,
    ticker,
  });

  const tx = new Transaction().add(ix);
  await sendTx(provider, tx, [admin]);

  return priceFeed;
}

// ---------------------------------------------------------------------------
// Update oracle price
// ---------------------------------------------------------------------------

/**
 * Update a PriceFeed with a new price, confidence, and timestamp.
 * @param price      Price in USDC lamports (e.g. 200_000_000 = $200.00)
 * @param confidence Confidence band in USDC lamports
 */
export async function updateOraclePrice(
  context: ProgramTestContext,
  admin: Keypair,
  feed: PublicKey,
  price: number,
  confidence: number,
): Promise<void> {
  const provider = new BankrunProvider(context);

  const clock = await context.banksClient.getClock();
  const timestamp = Number(clock.unixTimestamp);

  const ix = buildUpdatePriceIx({
    authority: admin.publicKey,
    priceFeed: feed,
    price: new BN(price),
    confidence: new BN(confidence),
    timestamp: new BN(timestamp),
  });

  const tx = new Transaction().add(ix);
  await sendTx(provider, tx, [admin]);
}

// ---------------------------------------------------------------------------
// Create test market
// ---------------------------------------------------------------------------

/**
 * Create a full StrikeMarket with all derived PDAs (yes/no mints, vaults,
 * escrows, order book).
 *
 * @param strikePrice    Strike price in USDC lamports (e.g. 200_000_000)
 * @param marketCloseUnix  UTC timestamp for market close
 * @param previousClose  Previous closing price in USDC lamports
 */
export async function createTestMarket(
  context: ProgramTestContext,
  admin: Keypair,
  config: PublicKey,
  ticker: string,
  strikePrice: number,
  marketCloseUnix: number,
  previousClose: number,
  oracleFeed: PublicKey,
  usdcMint: PublicKey,
): Promise<MarketAccounts> {
  const provider = new BankrunProvider(context);

  const strikePriceBN = new BN(strikePrice);
  const expiryDay = Math.floor(marketCloseUnix / 86400);

  const [market] = findStrikeMarket(ticker, strikePriceBN, marketCloseUnix);
  const [yesMint] = findYesMint(market);
  const [noMint] = findNoMint(market);
  const [usdcVault] = findUsdcVault(market);
  const [escrowVault] = findEscrowVault(market);
  const [yesEscrow] = findYesEscrow(market);
  const [noEscrow] = findNoEscrow(market);
  const [orderBook] = findOrderBook(market);

  // The OrderBook is ~127KB which exceeds the 10,240 byte CPI allocation limit.
  // Pre-allocate the PDA with correct space, lamports, and program ownership.
  // The Rust side uses `#[account(zero)]` which expects:
  //   - Account owned by the meridian program
  //   - All data zeroed (Anchor sets discriminator)
  //   - Correct space already allocated
  const ORDER_BOOK_SPACE = 8 + 127_560; // discriminator + data
  const orderBookRent = await context.banksClient.getRent();
  const orderBookLamports = Number(orderBookRent.minimumBalance(BigInt(ORDER_BOOK_SPACE)));

  context.setAccount(orderBook, {
    lamports: orderBookLamports,
    data: Buffer.alloc(ORDER_BOOK_SPACE, 0),
    owner: MERIDIAN_PROGRAM_ID,
    executable: false,
  });

  const ix = buildCreateStrikeMarketIx({
    admin: admin.publicKey,
    config,
    market,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
    oracleFeed,
    usdcMint,
    ticker: padTicker(ticker),
    strikePrice: strikePriceBN,
    expiryDay,
    marketCloseUnix: new BN(marketCloseUnix),
    previousClose: new BN(previousClose),
  });

  const tx = new Transaction().add(ix);
  await sendTx(provider, tx, [admin]);

  return {
    market,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
  };
}

// ---------------------------------------------------------------------------
// Mint test USDC to a user
// ---------------------------------------------------------------------------

/**
 * Mint mock USDC tokens to a destination token account.
 * Uses raw MintTo instruction for bankrun compatibility.
 * @param amount  Amount in USDC lamports (e.g. 1_000_000_000 = $1000)
 */
export async function mintTestUsdc(
  context: ProgramTestContext,
  mint: PublicKey,
  authority: Keypair,
  destination: PublicKey,
  amount: number,
): Promise<void> {
  const provider = new BankrunProvider(context);

  const tx = new Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      authority.publicKey,
      amount,
    ),
  );

  await sendTx(provider, tx, [authority]);
}

/**
 * Create an associated token account for a user.
 * Uses raw instruction for bankrun compatibility.
 */
export async function createAta(
  context: ProgramTestContext,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const provider = new BankrunProvider(context);
  const ata = getAssociatedTokenAddressSync(mint, owner);

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
    ),
  );

  await sendTx(provider, tx, [payer]);
  return ata;
}
