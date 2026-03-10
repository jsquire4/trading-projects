// ---------------------------------------------------------------------------
// Market Initializer — core logic
//
// For each active ticker:
//   1. Fetch previous close from Tradier
//   2. Calculate strikes (±3/6/9%, $10 rounding)
//   3. Compute today's 4:00 PM ET close timestamp (DST-aware)
//   4. For each strike, idempotently create on-chain market + ALT
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { TradierClient } from "../../shared/src/tradier-client.ts";
import { createLogger } from "../../shared/src/alerting.ts";
import { generateStrikes } from "../../../app/meridian-web/src/lib/strikes.ts";
import {
  findGlobalConfig,
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findPriceFeed,
  padTicker,
} from "../../../app/meridian-web/src/lib/pda.ts";

import type { Meridian } from "../../shared/src/idl/meridian.ts";
import MeridianIDL from "../../shared/src/idl/meridian.json";
import { createMarketAlt, type MarketAccounts } from "./alt.ts";
import { getETOffsetMinutes as getETOffset } from "../../automation/src/timezone.ts";

const log = createLogger("market-initializer");

// USDC has 6 decimals — $1.00 = 1_000_000 lamports
const USDC_DECIMALS = 6;

// OrderBook needs ~127KB, allocated in 10KB increments
const ORDER_BOOK_ALLOC_CALLS = 13;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitResult {
  ticker: string;
  previousClose: number;
  strikesCreated: number;
  strikesSkipped: number;
  errors: string[];
}

export async function initializeMarkets(): Promise<InitResult[]> {
  // ---- Environment ---------------------------------------------------------
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const tickers = (
    process.env.TICKERS ?? "AAPL,TSLA,AMZN,MSFT,NVDA,GOOGL,META"
  )
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const adminSecret = process.env.ADMIN_KEYPAIR;
  if (!adminSecret) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

  // Decode base58 secret key
  const { default: bs58 } = await import("bs58");
  const adminKeypair = Keypair.fromSecretKey(bs58.decode(adminSecret));

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const program = new Program<Meridian>(
    MeridianIDL as unknown as Meridian,
    provider,
  );

  // ---- Fetch GlobalConfig to get usdc_mint ---------------------------------
  const [configPda] = findGlobalConfig();
  const configAccount = await (program.account as any).globalConfig.fetch(
    configPda,
  );
  const usdcMint: PublicKey = configAccount.usdcMint;

  log.info("Loaded GlobalConfig", {
    admin: configAccount.admin.toBase58(),
    usdcMint: usdcMint.toBase58(),
  });

  // ---- Tradier quotes ------------------------------------------------------
  const tradier = new TradierClient();
  const quotes = await tradier.getQuotes(tickers);

  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  for (const t of tickers) {
    if (!quoteMap.has(t)) {
      log.error(`No quote returned for ticker ${t}`);
    }
  }

  // ---- Compute market close (4:00 PM ET today, DST-aware) ------------------
  const marketCloseUnix = computeMarketCloseUnix();
  const expiryDay = Math.floor(marketCloseUnix / 86400);

  log.info("Market close computed", {
    marketCloseUnix,
    expiryDay,
    iso: new Date(marketCloseUnix * 1000).toISOString(),
  });

  // ---- Process each ticker -------------------------------------------------
  const results: InitResult[] = [];

  for (const ticker of tickers) {
    const quote = quoteMap.get(ticker);
    if (!quote) {
      results.push({
        ticker,
        previousClose: 0,
        strikesCreated: 0,
        strikesSkipped: 0,
        errors: [`No quote data for ${ticker}`],
      });
      continue;
    }

    const result = await processTickerStrikes(
      program,
      connection,
      adminKeypair,
      configPda,
      usdcMint,
      ticker,
      quote.prevclose,
      marketCloseUnix,
      expiryDay,
    );
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-ticker processing
// ---------------------------------------------------------------------------

async function processTickerStrikes(
  program: Program<Meridian>,
  connection: Connection,
  admin: Keypair,
  configPda: PublicKey,
  usdcMint: PublicKey,
  ticker: string,
  previousClose: number,
  marketCloseUnix: number,
  expiryDay: number,
): Promise<InitResult> {
  const result: InitResult = {
    ticker,
    previousClose,
    strikesCreated: 0,
    strikesSkipped: 0,
    errors: [],
  };

  const { strikes } = generateStrikes(previousClose);

  log.info(`Processing ${ticker}`, {
    previousClose,
    strikes,
    strikeCount: strikes.length,
  });

  for (const strikeDollars of strikes) {
    // Convert dollar strike to USDC lamports: $680 → 680_000_000
    const strikeLamports = BigInt(strikeDollars) * BigInt(10 ** USDC_DECIMALS);
    const previousCloseLamports =
      BigInt(Math.round(previousClose * 10 ** USDC_DECIMALS));

    try {
      const created = await createSingleMarket(
        program,
        connection,
        admin,
        configPda,
        usdcMint,
        ticker,
        strikeLamports,
        previousCloseLamports,
        marketCloseUnix,
        expiryDay,
      );

      if (created) {
        result.strikesCreated++;
        log.info(`Created market: ${ticker} @ $${strikeDollars}`, {
          strikeLamports: strikeLamports.toString(),
        });
      } else {
        result.strikesSkipped++;
        log.info(`Skipped (exists): ${ticker} @ $${strikeDollars}`);
      }
    } catch (err: any) {
      const msg = `Failed ${ticker} @ $${strikeDollars}: ${err.message ?? err}`;
      result.errors.push(msg);
      log.error(msg, { stack: err.stack });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single market creation (idempotent)
// ---------------------------------------------------------------------------

async function createSingleMarket(
  program: Program<Meridian>,
  connection: Connection,
  admin: Keypair,
  configPda: PublicKey,
  usdcMint: PublicKey,
  ticker: string,
  strikeLamports: bigint,
  previousCloseLamports: bigint,
  marketCloseUnix: number,
  expiryDay: number,
): Promise<boolean> {
  // Derive PDAs
  const [marketPda] = findStrikeMarket(ticker, strikeLamports, marketCloseUnix);
  const [yesMint] = findYesMint(marketPda);
  const [noMint] = findNoMint(marketPda);
  const [usdcVault] = findUsdcVault(marketPda);
  const [escrowVault] = findEscrowVault(marketPda);
  const [yesEscrow] = findYesEscrow(marketPda);
  const [noEscrow] = findNoEscrow(marketPda);
  const [orderBook] = findOrderBook(marketPda);
  const [oracleFeed] = findPriceFeed(ticker);

  // ---- Idempotency check: does market already exist? -----------------------
  const existing = await connection.getAccountInfo(marketPda);
  if (existing !== null) {
    return false; // already exists
  }

  // ---- Step 1: Allocate OrderBook (incremental, ~10KB per call) ------------
  // Check existing order book size for crash recovery (partial prior allocation)
  const existingOb = await connection.getAccountInfo(orderBook);
  const existingAllocCalls = existingOb ? Math.floor(existingOb.data.length / 10240) : 0;
  const remainingCalls = Math.max(0, ORDER_BOOK_ALLOC_CALLS - existingAllocCalls);

  if (remainingCalls > 0) {
    log.info(`Allocating order book for ${ticker} (${remainingCalls} calls, ${existingAllocCalls} already done)...`);

    for (let i = 0; i < remainingCalls; i++) {
      await program.methods
        .allocateOrderBook(marketPda)
        .accounts({
          payer: admin.publicKey,
          orderBook: orderBook,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
    }
  } else {
    log.info(`Order book for ${ticker} already fully allocated`);
  }

  // ---- Step 2: Create strike market ----------------------------------------
  const tickerBytes = Array.from(padTicker(ticker));

  await program.methods
    .createStrikeMarket(
      tickerBytes as unknown as number[],
      new BN(strikeLamports.toString()),
      expiryDay,
      new BN(marketCloseUnix),
      new BN(previousCloseLamports.toString()),
    )
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      market: marketPda,
      yesMint: yesMint,
      noMint: noMint,
      usdcVault: usdcVault,
      escrowVault: escrowVault,
      yesEscrow: yesEscrow,
      noEscrow: noEscrow,
      orderBook: orderBook,
      oracleFeed: oracleFeed,
      usdcMint: usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin])
    .rpc({ commitment: "confirmed" });

  // ---- Step 3: Create ALT and store on-chain -------------------------------
  const altAccounts: MarketAccounts = {
    market: marketPda,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
    oracleFeed,
  };

  const altAddress = await createMarketAlt(connection, admin, altAccounts);

  log.info(`ALT created: ${altAddress.toBase58()}`, {
    market: marketPda.toBase58(),
  });

  // ---- Step 4: Store ALT address on the market account ---------------------
  await program.methods
    .setMarketAlt(altAddress)
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      market: marketPda,
    })
    .signers([admin])
    .rpc({ commitment: "confirmed" });

  return true;
}

// ---------------------------------------------------------------------------
// Compute 4:00 PM ET today as UTC unix timestamp (DST-aware)
// ---------------------------------------------------------------------------

export function computeMarketCloseUnix(date?: Date): number {
  const now = date ?? new Date();

  // Format in America/New_York to figure out the local date
  const nyFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = nyFormatter.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value);
  const month = parseInt(parts.find((p) => p.type === "month")!.value);
  const day = parseInt(parts.find((p) => p.type === "day")!.value);

  const etOffsetMinutes = getETOffset(now);

  // Start of day in UTC
  const startOfDayUTC = Date.UTC(year, month - 1, day, 0, 0, 0);
  // 4 PM ET in minutes from midnight ET = 960 minutes
  // Convert to UTC: 960 - etOffsetMinutes (offset is negative for behind UTC)
  const marketCloseUTC = startOfDayUTC + (16 * 60 - etOffsetMinutes) * 60 * 1000;

  return Math.floor(marketCloseUTC / 1000);
}

