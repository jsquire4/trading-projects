/**
 * create-test-markets.ts — Create a test AAPL strike market for today,
 * then create and attach an Address Lookup Table (ALT).
 *
 * Idempotent: skips if the market PDA already exists on-chain.
 * Builds all instructions manually using Anchor discriminator convention.
 *
 * Run:  npx ts-node scripts/create-test-markets.ts
 */

import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

const DEVNET_URL = "https://api.devnet.solana.com";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

const MERIDIAN_PROGRAM_ID = new PublicKey("7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth");
const MOCK_ORACLE_PROGRAM_ID = new PublicKey("HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ");

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

/** Pad a ticker string to exactly 8 bytes (zero-padded). */
function tickerBytes(ticker: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  buf.write(ticker, "utf-8");
  return buf;
}

/** Compute Anchor instruction discriminator. */
function anchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.subarray(0, 8);
}

/**
 * Get today's 4:00 PM ET as a Unix timestamp.
 * ET = UTC-5 (EST) or UTC-4 (EDT). We detect based on Date offset.
 */
function todayMarketCloseUnix(): number {
  const now = new Date();
  // Create a date for today in ET
  const etOffset = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etOffset);

  // Build 4:00 PM ET today
  const closeET = new Date(etNow);
  closeET.setHours(16, 0, 0, 0);

  // Convert back: figure out the UTC offset for ET today
  const utcNow = now.getTime();
  const etNowMs = etNow.getTime();
  // This gives us the local-to-ET offset from the string parse, but we need
  // to be precise. Use a direct approach:
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  // We need ET offset, not local offset. Use Intl to get it.
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = etFormatter.formatToParts(now);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "0";
  const etYear = parseInt(getPart("year"));
  const etMonth = parseInt(getPart("month")) - 1;
  const etDay = parseInt(getPart("day"));

  // Build 4PM ET as UTC by adding the ET-to-UTC offset
  // ET is either UTC-5 or UTC-4. Determine by comparing:
  const etDateStr = `${getPart("year")}-${getPart("month")}-${getPart("day")}T${getPart("hour")}:${getPart("minute")}:${getPart("second")}`;
  const etDateUtc = new Date(etDateStr + "Z"); // treat as UTC
  const diffMs = now.getTime() - etDateUtc.getTime();
  // diffMs is the ET-to-UTC offset in ms (positive means ET is behind UTC)
  // For EST: diffMs ≈ 5*3600*1000, for EDT: diffMs ≈ 4*3600*1000
  const etOffsetHours = Math.round(diffMs / (3600 * 1000));

  // 4PM ET in UTC
  const closeUtcMs = new Date(
    Date.UTC(etYear, etMonth, etDay, 16 + etOffsetHours, 0, 0)
  ).getTime();

  // If market close is already past, use tomorrow
  const closeUnix = Math.floor(closeUtcMs / 1000);
  if (closeUnix <= Math.floor(Date.now() / 1000)) {
    return closeUnix + 86400; // tomorrow same time
  }
  return closeUnix;
}

/** Compute expiry_day as floor(unix / 86400) — Unix day number, matching Rust PDA seeds. */
function expiryDayFromUnix(unix: number): number {
  return Math.floor(unix / 86400);
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const connection = new Connection(DEVNET_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  // ── Read USDC_MINT from .env ───────────────────────────────────────────────
  const env = readEnv();
  if (!env["USDC_MINT"]) {
    console.error("ERROR: USDC_MINT not found in .env. Run create-mock-usdc.ts first.");
    process.exit(1);
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  console.log(`USDC Mint: ${usdcMint.toBase58()}`);

  // ── Market parameters ──────────────────────────────────────────────────────
  const ticker = "AAPL";
  const tBytes = tickerBytes(ticker);
  const strikePrice = new BN(200_000_000);     // $200.00
  const previousClose = new BN(198_000_000);   // $198.00
  const marketCloseUnix = todayMarketCloseUnix();
  const expiryDay = expiryDayFromUnix(marketCloseUnix);

  console.log(`\nMarket parameters:`);
  console.log(`  Ticker:         ${ticker}`);
  console.log(`  Strike:         $${strikePrice.toNumber() / 1_000_000}`);
  console.log(`  Previous close: $${previousClose.toNumber() / 1_000_000}`);
  console.log(`  Market close:   ${new Date(marketCloseUnix * 1000).toISOString()}`);
  console.log(`  Expiry day:     ${expiryDay}`);

  // ── Derive all PDAs ────────────────────────────────────────────────────────
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID
  );

  const [marketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      tBytes,
      strikePrice.toArrayLike(Buffer, "le", 8),
      new BN(expiryDay).toArrayLike(Buffer, "le", 4),
    ],
    MERIDIAN_PROGRAM_ID
  );

  // All child PDAs are seeded off market's pubkey
  const mkSeed = marketPda.toBuffer();

  const [yesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [usdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [escrowVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [yesEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [noEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_escrow"), mkSeed], MERIDIAN_PROGRAM_ID
  );
  const [orderBook] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_book"), mkSeed], MERIDIAN_PROGRAM_ID
  );

  // Oracle feed PDA (on mock_oracle program)
  const [oracleFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), tBytes],
    MOCK_ORACLE_PROGRAM_ID
  );

  console.log(`\nDerived PDAs:`);
  console.log(`  Config:      ${configPda.toBase58()}`);
  console.log(`  Market:      ${marketPda.toBase58()}`);
  console.log(`  Yes Mint:    ${yesMint.toBase58()}`);
  console.log(`  No Mint:     ${noMint.toBase58()}`);
  console.log(`  USDC Vault:  ${usdcVault.toBase58()}`);
  console.log(`  Escrow:      ${escrowVault.toBase58()}`);
  console.log(`  Yes Escrow:  ${yesEscrow.toBase58()}`);
  console.log(`  No Escrow:   ${noEscrow.toBase58()}`);
  console.log(`  Order Book:  ${orderBook.toBase58()}`);
  console.log(`  Oracle Feed: ${oracleFeed.toBase58()}`);

  // ── Idempotency check ─────────────────────────────────────────────────────
  const existingMarket = await connection.getAccountInfo(marketPda);
  if (existingMarket) {
    console.log("\nMarket already exists on-chain. Skipping creation.");
    // Still check if ALT needs to be set
    await maybeSetAlt(connection, admin, configPda, marketPda, existingMarket.data, {
      yesMint, noMint, usdcVault, escrowVault, yesEscrow, noEscrow, orderBook,
      oracleFeed, usdcMint, configPda, marketPda,
    });
    return;
  }

  // ── Pre-allocate OrderBook PDA (>10KB, requires incremental allocation) ───
  const ORDER_BOOK_TOTAL_SPACE = 8 + 127_560; // 127,568 bytes
  const MAX_GROWTH = 10_240;
  const allocCalls = Math.ceil(ORDER_BOOK_TOTAL_SPACE / MAX_GROWTH); // ~13

  const existingOB = await connection.getAccountInfo(orderBook);
  const currentOBLen = existingOB?.data.length ?? 0;

  if (currentOBLen < ORDER_BOOK_TOTAL_SPACE) {
    console.log(`\nPre-allocating OrderBook PDA (${ORDER_BOOK_TOTAL_SPACE} bytes, ~${allocCalls} calls)...`);
    console.log(`  Current size: ${currentOBLen} bytes`);

    // Build allocate_order_book instructions and batch into transactions
    const allocDisc = anchorDiscriminator("allocate_order_book");
    const allocData = Buffer.concat([allocDisc, marketPda.toBuffer()]);

    const allocKeys = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const allocIx = new TransactionInstruction({
      programId: MERIDIAN_PROGRAM_ID,
      keys: allocKeys,
      data: allocData,
    });

    // Each instruction grows the account by up to 10KB.
    // Batch multiple instructions per transaction (limited by tx size).
    const BATCH_SIZE = 6; // ~6 alloc instructions per tx fits within 1232 byte limit
    const remainingCalls = Math.ceil((ORDER_BOOK_TOTAL_SPACE - currentOBLen) / MAX_GROWTH);

    for (let i = 0; i < remainingCalls; i += BATCH_SIZE) {
      const batchCount = Math.min(BATCH_SIZE, remainingCalls - i);
      const batchTx = new Transaction();
      for (let j = 0; j < batchCount; j++) {
        batchTx.add(allocIx);
      }
      const allocSig = await sendAndConfirmTransaction(connection, batchTx, [admin], {
        commitment: "confirmed",
      });
      const progress = Math.min((i + batchCount) * MAX_GROWTH + currentOBLen, ORDER_BOOK_TOTAL_SPACE);
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${progress}/${ORDER_BOOK_TOTAL_SPACE} bytes (sig: ${allocSig.slice(0, 16)}...)`);
    }

    console.log("OrderBook PDA fully allocated.");
  } else {
    console.log("\nOrderBook PDA already at full size.");
  }

  // ── Build create_strike_market instruction ─────────────────────────────────
  const disc = anchorDiscriminator("create_strike_market");

  // Data: disc(8) + ticker(8) + strike_price(8) + expiry_day(4) + market_close_unix(8) + previous_close(8)
  const data = Buffer.concat([
    disc,
    tBytes,
    strikePrice.toArrayLike(Buffer, "le", 8),
    new BN(expiryDay).toArrayLike(Buffer, "le", 4),
    new BN(marketCloseUnix).toArrayLike(Buffer, "le", 8),
    previousClose.toArrayLike(Buffer, "le", 8),
  ]);

  // Accounts must match CreateStrikeMarket struct order
  const keys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },     // admin
    { pubkey: configPda, isSigner: false, isWritable: false },          // config
    { pubkey: marketPda, isSigner: false, isWritable: true },           // market
    { pubkey: yesMint, isSigner: false, isWritable: true },             // yes_mint
    { pubkey: noMint, isSigner: false, isWritable: true },              // no_mint
    { pubkey: usdcVault, isSigner: false, isWritable: true },           // usdc_vault
    { pubkey: escrowVault, isSigner: false, isWritable: true },         // escrow_vault
    { pubkey: yesEscrow, isSigner: false, isWritable: true },           // yes_escrow
    { pubkey: noEscrow, isSigner: false, isWritable: true },            // no_escrow
    { pubkey: orderBook, isSigner: false, isWritable: true },           // order_book
    { pubkey: oracleFeed, isSigner: false, isWritable: false },         // oracle_feed
    { pubkey: usdcMint, isSigner: false, isWritable: false },           // usdc_mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
  ];

  const ix = new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });

  console.log("\nSending create_strike_market transaction...");
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
  });
  console.log(`Market created! Signature: ${sig}`);

  // ── Create and attach ALT ──────────────────────────────────────────────────
  await createAndSetAlt(connection, admin, configPda, marketPda, {
    yesMint, noMint, usdcVault, escrowVault, yesEscrow, noEscrow, orderBook,
    oracleFeed, usdcMint, configPda, marketPda,
  });

  console.log("\n=== Test market creation complete ===");
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALT helpers
// ═══════════════════════════════════════════════════════════════════════════════

interface MarketAddresses {
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
  usdcMint: PublicKey;
  configPda: PublicKey;
  marketPda: PublicKey;
}

/** Check if the market's ALT is already set; if not, create and set it. */
async function maybeSetAlt(
  connection: Connection,
  admin: Keypair,
  configPda: PublicKey,
  marketPda: PublicKey,
  marketData: Buffer,
  addrs: MarketAddresses
): Promise<void> {
  // The alt_address field is at offset: 8 (discriminator) + 9*32 (pubkeys before alt_address)
  // + 8*8 (u64/i64 fields) = 8 + 288 + 64 = 360
  const altOffset = 8 + (9 * 32) + (8 * 8); // 360
  const altBytes = marketData.subarray(altOffset, altOffset + 32);
  const altPubkey = new PublicKey(altBytes);

  if (!altPubkey.equals(PublicKey.default)) {
    console.log(`ALT already set: ${altPubkey.toBase58()}`);
    return;
  }

  console.log("ALT not yet set. Creating...");
  await createAndSetAlt(connection, admin, configPda, marketPda, addrs);
}

/** Create an ALT, populate it with all market addresses, and call set_market_alt. */
async function createAndSetAlt(
  connection: Connection,
  admin: Keypair,
  configPda: PublicKey,
  marketPda: PublicKey,
  addrs: MarketAddresses
): Promise<void> {
  const slot = await connection.getSlot("confirmed");

  // ── Step 1: Create ALT ─────────────────────────────────────────────────────
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: admin.publicKey,
    payer: admin.publicKey,
    recentSlot: slot,
  });

  console.log(`\nCreating ALT: ${altAddress.toBase58()}`);

  const createTx = new Transaction().add(createIx);
  const createSig = await sendAndConfirmTransaction(connection, createTx, [admin], {
    commitment: "confirmed",
  });
  console.log(`ALT created. Signature: ${createSig}`);

  // ── Step 2: Extend ALT with all market-related addresses ───────────────────
  const addressesToAdd = [
    addrs.configPda,
    addrs.marketPda,
    addrs.yesMint,
    addrs.noMint,
    addrs.usdcVault,
    addrs.escrowVault,
    addrs.yesEscrow,
    addrs.noEscrow,
    addrs.orderBook,
    addrs.oracleFeed,
    addrs.usdcMint,
    MERIDIAN_PROGRAM_ID,
    MOCK_ORACLE_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_RENT_PUBKEY,
  ];

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: admin.publicKey,
    authority: admin.publicKey,
    lookupTable: altAddress,
    addresses: addressesToAdd,
  });

  const extendTx = new Transaction().add(extendIx);
  const extendSig = await sendAndConfirmTransaction(connection, extendTx, [admin], {
    commitment: "confirmed",
  });
  console.log(`ALT extended with ${addressesToAdd.length} addresses. Signature: ${extendSig}`);

  // ── Step 3: Wait for ALT activation (needs 1 slot to become usable) ────────
  console.log("Waiting for ALT activation (1 slot)...");
  await sleep(500);
  // Confirm ALT is populated
  const altAccount = await connection.getAddressLookupTable(altAddress);
  if (altAccount.value) {
    console.log(`ALT active with ${altAccount.value.state.addresses.length} addresses.`);
  } else {
    console.log("WARNING: ALT not yet active. set_market_alt may need retry.");
  }

  // ── Step 4: Call set_market_alt on meridian ────────────────────────────────
  const setAltDisc = anchorDiscriminator("set_market_alt");
  const setAltData = Buffer.concat([setAltDisc, altAddress.toBuffer()]);

  const setAltKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },  // admin
    { pubkey: configPda, isSigner: false, isWritable: false },        // config
    { pubkey: marketPda, isSigner: false, isWritable: true },         // market
  ];

  const setAltIx = new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys: setAltKeys,
    data: setAltData,
  });

  const setAltTx = new Transaction().add(setAltIx);
  const setAltSig = await sendAndConfirmTransaction(connection, setAltTx, [admin], {
    commitment: "confirmed",
  });
  console.log(`set_market_alt done. Signature: ${setAltSig}`);
  console.log(`Market ALT set to: ${altAddress.toBase58()}`);
}
