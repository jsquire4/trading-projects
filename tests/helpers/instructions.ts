/**
 * instructions.ts — Raw TransactionInstruction builders for Meridian and
 * MockOracle programs.  No IDL required; discriminators are computed from
 * the Anchor convention: SHA256("global:<instruction_name>")[0..8].
 *
 * Account order in every builder matches the corresponding Rust
 * #[derive(Accounts)] struct exactly.
 */

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

export const MERIDIAN_PROGRAM_ID = new PublicKey(
  "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth",
);

export const MOCK_ORACLE_PROGRAM_ID = new PublicKey(
  "HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute Anchor instruction discriminator: first 8 bytes of SHA256("global:<name>"). */
export function anchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.subarray(0, 8);
}

/** Pad a ticker string to exactly 8 bytes (zero-padded on the right). */
export function padTicker(ticker: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  const bytes = Buffer.from(ticker, "utf-8");
  if (bytes.length > 8) {
    throw new Error(`Ticker "${ticker}" exceeds 8 bytes when UTF-8 encoded`);
  }
  bytes.copy(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Meridian: initialize_config
// ---------------------------------------------------------------------------

export interface InitializeConfigParams {
  admin: PublicKey;
  config: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  feeVault: PublicKey;
  solTreasury: PublicKey;
  oracleProgram: PublicKey;
  /** 7-element array of ticker strings (e.g. ["AAPL", "MSFT", ...]) */
  tickers: string[];
  tickerCount: number;
  stalenessThreshold: number;
  settlementStaleness: number;
  confidenceBps: number;
  oracleType: number;
}

export function buildInitializeConfigIx(
  params: InitializeConfigParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("initialize_config");

  // tickers: [[u8; 8]; 7] — always 56 bytes (pad with zero-filled slots if < 7)
  const tickerBufs: Buffer[] = [];
  for (let i = 0; i < 7; i++) {
    tickerBufs.push(i < params.tickers.length ? padTicker(params.tickers[i]) : Buffer.alloc(8, 0));
  }
  const tickersData = Buffer.concat(tickerBufs);

  const tickerCount = Buffer.from([params.tickerCount]);
  const stalenessThreshold = new BN(params.stalenessThreshold).toArrayLike(Buffer, "le", 8);
  const settlementStaleness = new BN(params.settlementStaleness).toArrayLike(Buffer, "le", 8);
  const confidenceBps = new BN(params.confidenceBps).toArrayLike(Buffer, "le", 8);
  const oracleType = Buffer.from([params.oracleType]);

  const data = Buffer.concat([
    disc,
    tickersData,      // 56 bytes
    tickerCount,      // 1 byte
    stalenessThreshold, // 8 bytes
    settlementStaleness, // 8 bytes
    confidenceBps,    // 8 bytes
    oracleType,       // 1 byte
  ]);

  // Account order matches InitializeConfig struct:
  //   admin, config, usdc_mint, treasury, fee_vault, sol_treasury,
  //   oracle_program, token_program, system_program, rent
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: true },
    { pubkey: params.usdcMint, isSigner: false, isWritable: false },
    { pubkey: params.treasury, isSigner: false, isWritable: true },
    { pubkey: params.feeVault, isSigner: false, isWritable: true },
    { pubkey: params.solTreasury, isSigner: false, isWritable: true },
    { pubkey: params.oracleProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: create_strike_market
// ---------------------------------------------------------------------------

export interface CreateStrikeMarketParams {
  admin: PublicKey;
  config: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
  usdcMint: PublicKey;
  /** Creator's USDC ATA for fee payment (pass null/program ID to skip) */
  creatorUsdcAta?: PublicKey;
  /** Fee vault PDA (pass null/program ID to skip) */
  feeVault?: PublicKey;
  /** TickerRegistry PDA (pass null/program ID to skip for legacy mode) */
  tickerRegistry?: PublicKey;
  /** 8-byte ticker (use padTicker) */
  ticker: Buffer;
  /** Strike price in USDC lamports */
  strikePrice: BN;
  /** floor(marketCloseUnix / 86400) */
  expiryDay: number;
  /** UTC timestamp for 4 PM ET market close */
  marketCloseUnix: BN;
  /** Previous closing price in USDC lamports */
  previousClose: BN;
}

export function buildCreateStrikeMarketIx(
  params: CreateStrikeMarketParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("create_strike_market");

  // Data: disc(8) + ticker(8) + strike_price(8) + expiry_day(4) +
  //       market_close_unix(8) + previous_close(8)
  const data = Buffer.concat([
    disc,
    params.ticker,
    params.strikePrice.toArrayLike(Buffer, "le", 8),
    new BN(params.expiryDay).toArrayLike(Buffer, "le", 4),
    params.marketCloseUnix.toArrayLike(Buffer, "le", 8),
    params.previousClose.toArrayLike(Buffer, "le", 8),
  ]);

  // Account order matches CreateStrikeMarket struct:
  //   creator, config, market, yes_mint, no_mint, usdc_vault, escrow_vault,
  //   yes_escrow, no_escrow, order_book, oracle_feed, usdc_mint,
  //   creator_usdc_ata (optional), fee_vault (optional),
  //   token_program, system_program, rent
  const creatorUsdcAta = params.creatorUsdcAta ?? MERIDIAN_PROGRAM_ID;
  const feeVault = params.feeVault ?? MERIDIAN_PROGRAM_ID;
  const tickerRegistry = params.tickerRegistry ?? MERIDIAN_PROGRAM_ID;
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: params.escrowVault, isSigner: false, isWritable: true },
    { pubkey: params.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: params.noEscrow, isSigner: false, isWritable: true },
    { pubkey: params.orderBook, isSigner: false, isWritable: true },
    { pubkey: params.oracleFeed, isSigner: false, isWritable: false },
    { pubkey: params.usdcMint, isSigner: false, isWritable: false },
    { pubkey: creatorUsdcAta, isSigner: false, isWritable: true },
    { pubkey: feeVault, isSigner: false, isWritable: true },
    { pubkey: tickerRegistry, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: set_market_alt
// ---------------------------------------------------------------------------

export interface SetMarketAltParams {
  admin: PublicKey;
  config: PublicKey;
  market: PublicKey;
  altAddress: PublicKey;
}

export function buildSetMarketAltIx(
  params: SetMarketAltParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("set_market_alt");

  // Data: disc(8) + alt_address(32)
  const data = Buffer.concat([disc, params.altAddress.toBuffer()]);

  // Account order matches SetMarketAlt struct:
  //   admin, config, market
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: mint_pair
// ---------------------------------------------------------------------------

export interface MintPairParams {
  user: PublicKey;
  config: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  userUsdcAta: PublicKey;
  userYesAta: PublicKey;
  userNoAta: PublicKey;
  usdcVault: PublicKey;
  /** Quantity in token lamports (min 1_000_000) */
  quantity: BN;
}

export function buildMintPairIx(
  params: MintPairParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("mint_pair");

  // Data: disc(8) + quantity(8)
  const data = Buffer.concat([
    disc,
    params.quantity.toArrayLike(Buffer, "le", 8),
  ]);

  // Account order matches MintPair struct:
  //   user, config, market, yes_mint, no_mint, user_usdc_ata, user_yes_ata,
  //   user_no_ata, usdc_vault, token_program, associated_token_program,
  //   system_program
  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.userUsdcAta, isSigner: false, isWritable: true },
    { pubkey: params.userYesAta, isSigner: false, isWritable: true },
    { pubkey: params.userNoAta, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// MockOracle: initialize_feed
// ---------------------------------------------------------------------------

export interface InitializeFeedParams {
  authority: PublicKey;
  priceFeed: PublicKey;
  /** Ticker string (e.g. "AAPL") */
  ticker: string;
}

export function buildInitializeFeedIx(
  params: InitializeFeedParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("initialize_feed");

  // Data: disc(8) + ticker([u8;8])
  const data = Buffer.concat([disc, padTicker(params.ticker)]);

  // Account order matches InitializeFeed struct:
  //   authority, price_feed, system_program
  const keys = [
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: params.priceFeed, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MOCK_ORACLE_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// MockOracle: update_price
// ---------------------------------------------------------------------------

export interface UpdatePriceParams {
  authority: PublicKey;
  priceFeed: PublicKey;
  /** Price in USDC lamports */
  price: BN;
  /** Confidence band in USDC lamports */
  confidence: BN;
  /** Unix timestamp (i64) */
  timestamp: BN;
}

export function buildUpdatePriceIx(
  params: UpdatePriceParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("update_price");

  // Data: disc(8) + price(8) + confidence(8) + timestamp(8)
  const data = Buffer.concat([
    disc,
    params.price.toArrayLike(Buffer, "le", 8),
    params.confidence.toArrayLike(Buffer, "le", 8),
    params.timestamp.toArrayLike(Buffer, "le", 8),
  ]);

  // Account order matches UpdatePrice struct:
  //   authority, price_feed
  const keys = [
    { pubkey: params.authority, isSigner: true, isWritable: false },
    { pubkey: params.priceFeed, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MOCK_ORACLE_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: place_order
// ---------------------------------------------------------------------------

export interface PlaceOrderParams {
  user: PublicKey;
  config: PublicKey;
  market: PublicKey;
  orderBook: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  userUsdcAta: PublicKey;
  userYesAta: PublicKey;
  userNoAta: PublicKey;
  feeVault: PublicKey;
  /** 0=USDC bid (Buy Yes), 1=Yes ask (Sell Yes), 2=No-backed bid (Sell No) */
  side: number;
  /** Price 1-99 */
  price: number;
  /** Quantity in token lamports */
  quantity: BN;
  /** 0=Market, 1=Limit */
  orderType: number;
  /** Max fills to execute */
  maxFills: number;
  /** Maker ATAs for fills (remaining_accounts) */
  makerAccounts?: PublicKey[];
}

export function buildPlaceOrderIx(
  params: PlaceOrderParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("place_order");

  // Data: disc(8) + side(1) + price(1) + quantity(8) + order_type(1) + max_fills(1)
  const data = Buffer.concat([
    disc,
    Buffer.from([params.side]),
    Buffer.from([params.price]),
    params.quantity.toArrayLike(Buffer, "le", 8),
    Buffer.from([params.orderType]),
    Buffer.from([params.maxFills]),
  ]);

  // Account order matches PlaceOrder struct:
  //   user, config, market, order_book, usdc_vault, escrow_vault,
  //   yes_escrow, no_escrow, yes_mint, no_mint,
  //   user_usdc_ata, user_yes_ata, user_no_ata, fee_vault,
  //   token_program, system_program
  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.orderBook, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: params.escrowVault, isSigner: false, isWritable: true },
    { pubkey: params.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: params.noEscrow, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.userUsdcAta, isSigner: false, isWritable: true },
    { pubkey: params.userYesAta, isSigner: false, isWritable: true },
    { pubkey: params.userNoAta, isSigner: false, isWritable: true },
    { pubkey: params.feeVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // Append maker accounts as remaining_accounts
  if (params.makerAccounts) {
    for (const acct of params.makerAccounts) {
      keys.push({ pubkey: acct, isSigner: false, isWritable: true });
    }
  }

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: cancel_order
// ---------------------------------------------------------------------------

export interface CancelOrderParams {
  user: PublicKey;
  config: PublicKey;
  market: PublicKey;
  orderBook: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  userUsdcAta: PublicKey;
  userYesAta: PublicKey;
  userNoAta: PublicKey;
  /** Price level (1-99) */
  price: number;
  /** Order ID from the book */
  orderId: BN;
}

export function buildCancelOrderIx(
  params: CancelOrderParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("cancel_order");

  // Data: disc(8) + price(1) + order_id(8)
  const data = Buffer.concat([
    disc,
    Buffer.from([params.price]),
    params.orderId.toArrayLike(Buffer, "le", 8),
  ]);

  // Account order matches CancelOrder struct:
  //   user, config, market, order_book, escrow_vault, yes_escrow, no_escrow,
  //   user_usdc_ata, user_yes_ata, user_no_ata, token_program
  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.orderBook, isSigner: false, isWritable: true },
    { pubkey: params.escrowVault, isSigner: false, isWritable: true },
    { pubkey: params.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: params.noEscrow, isSigner: false, isWritable: true },
    { pubkey: params.userUsdcAta, isSigner: false, isWritable: true },
    { pubkey: params.userYesAta, isSigner: false, isWritable: true },
    { pubkey: params.userNoAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: pause
// ---------------------------------------------------------------------------

export interface PauseParams {
  admin: PublicKey;
  config: PublicKey;
}

export function buildPauseIx(params: PauseParams): TransactionInstruction {
  const disc = anchorDiscriminator("pause");

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: unpause
// ---------------------------------------------------------------------------

export interface UnpauseParams {
  admin: PublicKey;
  config: PublicKey;
}

export function buildUnpauseIx(params: UnpauseParams): TransactionInstruction {
  const disc = anchorDiscriminator("unpause");

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: settle_market
// ---------------------------------------------------------------------------

export interface SettleMarketParams {
  caller: PublicKey;
  config: PublicKey;
  market: PublicKey;
  oracleFeed: PublicKey;
}

export function buildSettleMarketIx(
  params: SettleMarketParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("settle_market");

  const keys = [
    { pubkey: params.caller, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.oracleFeed, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: admin_settle
// ---------------------------------------------------------------------------

export interface AdminSettleParams {
  admin: PublicKey;
  config: PublicKey;
  market: PublicKey;
  settlementPrice: BN;
}

export function buildAdminSettleIx(
  params: AdminSettleParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("admin_settle");
  const data = Buffer.concat([
    disc,
    params.settlementPrice.toArrayLike(Buffer, "le", 8),
  ]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: admin_override_settlement
// ---------------------------------------------------------------------------

export interface AdminOverrideParams {
  admin: PublicKey;
  config: PublicKey;
  market: PublicKey;
  newSettlementPrice: BN;
}

export function buildAdminOverrideIx(
  params: AdminOverrideParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("admin_override_settlement");
  const data = Buffer.concat([
    disc,
    params.newSettlementPrice.toArrayLike(Buffer, "le", 8),
  ]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: redeem
// ---------------------------------------------------------------------------

export interface RedeemParams {
  user: PublicKey;
  config: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  userUsdcAta: PublicKey;
  userYesAta: PublicKey;
  userNoAta: PublicKey;
  /** 0=pair burn, 1=winner redemption */
  mode: number;
  quantity: BN;
}

export function buildRedeemIx(
  params: RedeemParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("redeem");
  const data = Buffer.concat([
    disc,
    Buffer.from([params.mode]),
    params.quantity.toArrayLike(Buffer, "le", 8),
  ]);

  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: params.userUsdcAta, isSigner: false, isWritable: true },
    { pubkey: params.userYesAta, isSigner: false, isWritable: true },
    { pubkey: params.userNoAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: crank_cancel
// ---------------------------------------------------------------------------

export interface CrankCancelParams {
  caller: PublicKey;
  config: PublicKey;
  market: PublicKey;
  orderBook: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  batchSize: number;
  /** One destination ATA per order to be cancelled */
  makerAccounts?: PublicKey[];
}

export function buildCrankCancelIx(
  params: CrankCancelParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("crank_cancel");
  const data = Buffer.concat([
    disc,
    Buffer.from([params.batchSize]),
  ]);

  const keys = [
    { pubkey: params.caller, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: false },
    { pubkey: params.orderBook, isSigner: false, isWritable: true },
    { pubkey: params.escrowVault, isSigner: false, isWritable: true },
    { pubkey: params.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: params.noEscrow, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  if (params.makerAccounts) {
    for (const acct of params.makerAccounts) {
      keys.push({ pubkey: acct, isSigner: false, isWritable: true });
    }
  }

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: close_market
// ---------------------------------------------------------------------------

export interface CloseMarketParams {
  admin: PublicKey;
  config: PublicKey;
  market: PublicKey;
  orderBook: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  treasury: PublicKey;
  solTreasury: PublicKey;
}

export function buildCloseMarketIx(
  params: CloseMarketParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("close_market");

  // Account order matches CloseMarket struct:
  //   admin, config, market, order_book, usdc_vault, escrow_vault,
  //   yes_escrow, no_escrow, yes_mint, no_mint, treasury, sol_treasury,
  //   token_program, system_program
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: true },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.orderBook, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: params.escrowVault, isSigner: false, isWritable: true },
    { pubkey: params.yesEscrow, isSigner: false, isWritable: true },
    { pubkey: params.noEscrow, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.treasury, isSigner: false, isWritable: true },
    { pubkey: params.solTreasury, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: update_fee_bps
// ---------------------------------------------------------------------------

export interface UpdateFeeBpsParams {
  admin: PublicKey;
  config: PublicKey;
  newFeeBps: number;
}

export function buildUpdateFeeBpsIx(
  params: UpdateFeeBpsParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("update_fee_bps");

  // Data: disc(8) + new_fee_bps(2, u16 LE)
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(params.newFeeBps);

  const data = Buffer.concat([disc, feeBuf]);

  // Account order matches UpdateFeeBps struct:
  //   admin, config
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: update_strike_creation_fee
// ---------------------------------------------------------------------------

export interface UpdateStrikeCreationFeeParams {
  admin: PublicKey;
  config: PublicKey;
}

export function buildUpdateStrikeCreationFeeIx(
  params: UpdateStrikeCreationFeeParams,
  newFee: BN,
): TransactionInstruction {
  const disc = anchorDiscriminator("update_strike_creation_fee");
  const data = Buffer.concat([disc, newFee.toArrayLike(Buffer, "le", 8)]);

  // Account order matches UpdateStrikeCreationFee struct:
  //   admin, config
  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: crank_redeem
// ---------------------------------------------------------------------------

export interface CrankRedeemParams {
  caller: PublicKey;
  config: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
}

export function buildCrankRedeemIx(
  params: CrankRedeemParams,
  batchSize: number,
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
): TransactionInstruction {
  const disc = anchorDiscriminator("crank_redeem");
  const data = Buffer.concat([disc, Buffer.from([batchSize])]);

  const keys = [
    { pubkey: params.caller, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.market, isSigner: false, isWritable: true },
    { pubkey: params.yesMint, isSigner: false, isWritable: true },
    { pubkey: params.noMint, isSigner: false, isWritable: true },
    { pubkey: params.usdcVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remainingAccounts,
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ===========================================================================
// Phase 6A: Admin V2 instruction builders
// ===========================================================================

// ---------------------------------------------------------------------------
// Meridian: transfer_admin
// ---------------------------------------------------------------------------

export interface TransferAdminParams {
  admin: PublicKey;
  config: PublicKey;
  newAdmin: PublicKey;
}

export function buildTransferAdminIx(
  params: TransferAdminParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("transfer_admin");
  const data = Buffer.concat([disc, params.newAdmin.toBuffer()]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: accept_admin
// ---------------------------------------------------------------------------

export interface AcceptAdminParams {
  newAdmin: PublicKey;
  config: PublicKey;
}

export function buildAcceptAdminIx(
  params: AcceptAdminParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("accept_admin");

  const keys = [
    { pubkey: params.newAdmin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: withdraw_fees
// ---------------------------------------------------------------------------

export interface WithdrawFeesParams {
  admin: PublicKey;
  config: PublicKey;
  feeVault: PublicKey;
  adminUsdcAta: PublicKey;
}

export function buildWithdrawFeesIx(
  params: WithdrawFeesParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("withdraw_fees");

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.feeVault, isSigner: false, isWritable: true },
    { pubkey: params.adminUsdcAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: withdraw_treasury
// ---------------------------------------------------------------------------

export interface WithdrawTreasuryParams {
  admin: PublicKey;
  config: PublicKey;
  treasury: PublicKey;
  adminUsdcAta: PublicKey;
  amount: BN;
}

export function buildWithdrawTreasuryIx(
  params: WithdrawTreasuryParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("withdraw_treasury");
  const amountBuf = params.amount.toArrayLike(Buffer, "le", 8);
  const data = Buffer.concat([disc, amountBuf]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.treasury, isSigner: false, isWritable: true },
    { pubkey: params.adminUsdcAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: update_config
// ---------------------------------------------------------------------------

export interface UpdateConfigParams {
  admin: PublicKey;
  config: PublicKey;
  stalenessThreshold?: BN | null;
  settlementStaleness?: BN | null;
  confidenceBps?: BN | null;
  operatingReserve?: BN | null;
  settlementBlackoutMinutes?: number | null;
}

/** Encode Anchor Option<u64>: 0x00 = None, 0x01 + le_bytes = Some */
function optU64(val?: BN | null): Buffer {
  if (val == null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), val.toArrayLike(Buffer, "le", 8)]);
}

function optU16(val?: number | null): Buffer {
  if (val == null) return Buffer.from([0]);
  const buf = Buffer.alloc(3);
  buf[0] = 1;
  buf.writeUInt16LE(val, 1);
  return buf;
}

export function buildUpdateConfigIx(
  params: UpdateConfigParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("update_config");

  const data = Buffer.concat([
    disc,
    optU64(params.stalenessThreshold),
    optU64(params.settlementStaleness),
    optU64(params.confidenceBps),
    optU64(params.operatingReserve),
    optU16(params.settlementBlackoutMinutes),
  ]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: add_ticker
// ---------------------------------------------------------------------------

export interface AddTickerParams {
  payer: PublicKey;
  config: PublicKey;
  tickerRegistry: PublicKey;
  ticker: Buffer; // 8-byte padded ticker
  /** Pyth price account (only when oracle_type == Pyth) */
  pythFeed?: PublicKey;
}

export function buildAddTickerIx(
  params: AddTickerParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("add_ticker");
  const data = Buffer.concat([disc, params.ticker]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.tickerRegistry, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const remainingAccounts = params.pythFeed
    ? [{ pubkey: params.pythFeed, isSigner: false, isWritable: false }]
    : [];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys: [...keys, ...remainingAccounts],
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: deactivate_ticker
// ---------------------------------------------------------------------------

export interface DeactivateTickerParams {
  admin: PublicKey;
  config: PublicKey;
  tickerRegistry: PublicKey;
  ticker: Buffer; // 8-byte padded ticker
}

export function buildDeactivateTickerIx(
  params: DeactivateTickerParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("deactivate_ticker");
  const data = Buffer.concat([disc, params.ticker]);

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.tickerRegistry, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Meridian: circuit_breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerParams {
  admin: PublicKey;
  config: PublicKey;
}

export function buildCircuitBreakerIx(
  params: CircuitBreakerParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("circuit_breaker");

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: false },
    { pubkey: params.config, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Meridian: initialize_ticker_registry
// ---------------------------------------------------------------------------

export interface InitializeTickerRegistryParams {
  admin: PublicKey;
  config: PublicKey;
  tickerRegistry: PublicKey;
}

export function buildInitializeTickerRegistryIx(
  params: InitializeTickerRegistryParams,
): TransactionInstruction {
  const disc = anchorDiscriminator("initialize_ticker_registry");

  const keys = [
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.tickerRegistry, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data: disc,
  });
}
