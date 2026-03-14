import { PublicKey } from "@solana/web3.js";

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
// Seed helpers
// ---------------------------------------------------------------------------

/** Encode a ticker string as 8 bytes, zero-padded on the right. */
export function padTicker(ticker: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  const bytes = Buffer.from(ticker, "utf-8");
  if (bytes.length > 8) {
    throw new Error(`Ticker "${ticker}" exceeds 8 bytes when UTF-8 encoded`);
  }
  bytes.copy(buf);
  return buf;
}

/** Encode a strike price (USDC lamports) as a little-endian u64 buffer. */
export function strikeToBuffer(strikePriceLamports: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(strikePriceLamports);
  return buf;
}

/** Compute the expiry day (floor(unix / 86400)) and return it as a LE u32 buffer. */
export function expiryDayBuffer(marketCloseUnix: number): Buffer {
  const day = Math.floor(marketCloseUnix / 86400);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(day);
  return buf;
}

// ---------------------------------------------------------------------------
// Meridian PDAs
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
  strikePriceLamports: bigint,
  marketCloseUnix: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      padTicker(ticker),
      strikeToBuffer(strikePriceLamports),
      expiryDayBuffer(marketCloseUnix),
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

export function findFeeVault(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault")],
    MERIDIAN_PROGRAM_ID,
  );
}

export function findTickerRegistry(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tickers")],
    MERIDIAN_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Mock Oracle PDAs
// ---------------------------------------------------------------------------

export function findPriceFeed(ticker: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), padTicker(ticker)],
    MOCK_ORACLE_PROGRAM_ID,
  );
}
