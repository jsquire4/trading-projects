// ---------------------------------------------------------------------------
// Market Initializer — core logic
//
// For each active ticker:
//   1. Fetch previous close from market data client
//   2. Calculate strikes (±3/6/9%, $10 rounding)
//   3. Compute today's 4:00 PM ET close timestamp (DST-aware)
//   4. For each strike, idempotently create on-chain market + ALT
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { createMarketDataClient, type IMarketDataClient } from "../../shared/src/market-data.js";
import { createLogger } from "../../shared/src/alerting.js";
import { getETOffsetMinutes, isMarketDay } from "../../shared/src/timezone.js";
import { generateVolAwareStrikes } from "./strikeSelector.js";
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
} from "../../shared/src/pda.js";

import type { Meridian } from "../../shared/src/idl/meridian.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };
import { createMarketAlt, type MarketAccounts } from "./alt.js";

const log = createLogger("market-initializer");

// USDC has 6 decimals — $1.00 = 1_000_000 lamports
const USDC_DECIMALS = 6;

// OrderBook is now created inline by create_strike_market (sparse layout, 168 bytes)

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
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
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

  // ---- Market data quotes ---------------------------------------------------
  const marketData = createMarketDataClient();
  const quotes = await marketData.getQuotes(tickers);

  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  for (const t of tickers) {
    if (!quoteMap.has(t)) {
      log.error(`No quote returned for ticker ${t}`);
    }
  }

  // ---- Compute market close (4:00 PM ET today, DST-aware) ------------------
  const marketCloseUnix = await computeMarketCloseUnix();
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

    // Guard: skip tickers with missing or invalid previous close (#7)
    if (!quote.prevclose || quote.prevclose <= 0) {
      results.push({
        ticker,
        previousClose: quote.prevclose ?? 0,
        strikesCreated: 0,
        strikesSkipped: 0,
        errors: [`Invalid prevclose for ${ticker}: ${quote.prevclose}`],
      });
      continue;
    }

    const result = await processTickerStrikes(
      program,
      connection,
      adminKeypair,
      configPda,
      usdcMint,
      marketData,
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
  marketData: IMarketDataClient,
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

  // Fetch 60-day price history for vol-aware strike calculation
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 90); // request 90 calendar days to get ~60 trading days
  const bars = await marketData.getHistory(
    ticker,
    "daily",
    startDate.toISOString().slice(0, 10),
    now.toISOString().slice(0, 10),
  );

  const { strikes, method, hv20 } = generateVolAwareStrikes(previousClose, bars);

  log.info(`Processing ${ticker}`, {
    previousClose,
    strikes,
    strikeCount: strikes.length,
    method,
    hv20: hv20 !== undefined ? (hv20 * 100).toFixed(1) + "%" : "N/A",
    barsAvailable: bars.length,
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
    // Market exists — check if ALT still needs to be set (#8).
    // If market was created but ALT creation/set failed (crash recovery),
    // the altAddress will be the default pubkey (all zeros).
    try {
      const marketData = await (program.account as any).strikeMarket.fetch(marketPda);
      const altAddr = marketData.altAddress as PublicKey;
      if (altAddr.equals(PublicKey.default)) {
        log.info(`Market ${ticker} exists but ALT not set — creating ALT now`);

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
        await program.methods
          .setMarketAlt(altAddress)
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
          })
          .signers([admin])
          .rpc({ commitment: "confirmed" });

        log.info(`ALT set for existing market ${ticker}: ${altAddress.toBase58()}`);
      }
    } catch (err: any) {
      log.warn(`Failed to check/set ALT for existing market ${ticker}`, {
        error: err.message ?? String(err),
      });
    }
    return false; // already exists
  }

  // ---- Create strike market (order book created inline) --------------------
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

/**
 * Search forward day-by-day (up to 7 days) for the next valid trading day
 * and return its 4:00 PM ET close as a unix timestamp. Returns null if none found.
 */
async function findNextTradingDayClose(startOfDayUTC: number): Promise<number | null> {
  for (let advance = 1; advance <= 7; advance++) {
    const candidateStartUTC = startOfDayUTC + advance * 86_400_000;
    const candidate4pmUTC = candidateStartUTC + 16 * 60 * 60 * 1000;
    const candidateETOffset = getETOffsetMinutes(new Date(candidate4pmUTC));
    const candidateCloseUTC = candidateStartUTC + (16 * 60 - candidateETOffset) * 60 * 1000;
    const candidateDate = new Date(candidateCloseUTC);

    if (await isMarketDay(candidateDate)) {
      return Math.floor(candidateCloseUTC / 1000);
    }
  }
  return null;
}

export async function computeMarketCloseUnix(date?: Date): Promise<number> {
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

  // Compute ET-to-UTC offset (DST-aware) via shared timezone helper
  const etOffsetMinutes = getETOffsetMinutes(now);

  // Start of day in UTC
  let startOfDayUTC = Date.UTC(year, month - 1, day, 0, 0, 0);
  // 4 PM ET in minutes from midnight ET = 960 minutes
  // Convert to UTC: 960 - etOffsetMinutes (offset is negative for behind UTC)
  const marketCloseUTC = startOfDayUTC + (16 * 60 - etOffsetMinutes) * 60 * 1000;

  const closeUnix = Math.floor(marketCloseUTC / 1000);

  // If today's close has already passed, advance to the next valid trading day
  if (closeUnix <= Math.floor(Date.now() / 1000)) {
    const nextClose = await findNextTradingDayClose(startOfDayUTC);
    if (nextClose !== null) return nextClose;

    // Fallback: if no valid day found within 7 days (shouldn't happen), use +1 day
    const fallbackStartUTC = startOfDayUTC + 86_400_000;
    const fallback4pmUTC = fallbackStartUTC + 16 * 60 * 60 * 1000;
    const fallbackETOffset = getETOffsetMinutes(new Date(fallback4pmUTC));
    const fallbackCloseUTC = fallbackStartUTC + (16 * 60 - fallbackETOffset) * 60 * 1000;
    return Math.floor(fallbackCloseUTC / 1000);
  }

  // Today's close hasn't passed yet — check if today is a market day
  if (!(await isMarketDay(now))) {
    // Today is not a market day — advance to next valid trading day
    const nextClose = await findNextTradingDayClose(startOfDayUTC);
    if (nextClose !== null) return nextClose;
  }

  return closeUnix;
}

