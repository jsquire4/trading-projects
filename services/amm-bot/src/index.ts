// ---------------------------------------------------------------------------
// AMM Bot — Main Loop
//
// Automated market maker that seeds liquidity on Meridian binary option
// markets. Polls active markets, prices them with Black-Scholes, generates
// two-sided quotes with inventory skew, and executes on-chain.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { createLogger } from "../../shared/src/alerting.js";
import {
  MERIDIAN_PROGRAM_ID,
  findGlobalConfig,
  findPriceFeed,
  findYesMint,
  findNoMint,
} from "../../shared/src/pda.js";
import type { Meridian } from "../../shared/src/idl/meridian.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" assert { type: "json" };
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";
import MockOracleIDL from "../../shared/src/idl/mock_oracle.json" assert { type: "json" };
import { binaryCallPrice, probToCents } from "./pricer.js";
import {
  generateQuotes,
  shouldHalt,
  type QuoteConfig,
  DEFAULT_CONFIG,
} from "./quoter.js";
import { placeQuotes, type MarketAccounts } from "./executor.js";

const log = createLogger("amm-bot");

// ---------------------------------------------------------------------------
// Env / Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const SECONDS_PER_YEAR = 365.25 * 86_400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  const encoded = process.env.ADMIN_KEYPAIR;
  if (!encoded) {
    throw new Error(
      "ADMIN_KEYPAIR env var is required (base58-encoded secret key)",
    );
  }
  const secretKey = bs58.decode(encoded);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Decode a ticker from an on-chain [u8; 8] array, stripping zero-padding.
 */
function decodeTicker(raw: number[]): string {
  const end = raw.indexOf(0);
  const bytes = Buffer.from(raw.slice(0, end === -1 ? 8 : end));
  return bytes.toString("utf-8");
}

/**
 * Read the oracle price from a mock_oracle PriceFeed account.
 * Returns the price in dollars (e.g. 185.42).
 */
async function readOraclePrice(
  oracleProgram: Program<MockOracle>,
  priceFeedPubkey: PublicKey,
): Promise<number> {
  const feed = await oracleProgram.account.priceFeed.fetch(priceFeedPubkey);
  // Price is in USDC lamports (6 decimals)
  const priceLamports = (feed.price as any).toNumber
    ? (feed.price as any).toNumber()
    : Number(feed.price);
  return priceLamports / 1_000_000;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("AMM Bot starting up");

  // Load configuration from env
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  log.info(`RPC: ${rpcUrl}`);

  const admin = loadKeypair();
  log.info(`Admin: ${admin.publicKey.toBase58()}`);

  // BOT_QUANTITY is in raw USDC lamports (6 decimals). E.g. 1_000_000 = $1.00.
  const quantity = parseInt(process.env.BOT_QUANTITY ?? "1000000", 10);
  const spreadBps = parseInt(process.env.BOT_SPREAD_BPS ?? "500", 10);
  const vol = parseFloat(process.env.BOT_VOL ?? "0.30");
  const riskFreeRate = parseFloat(process.env.BOT_RISK_FREE_RATE ?? "0.05");

  const quoteConfig: QuoteConfig = {
    ...DEFAULT_CONFIG,
    spreadBps,
  };

  log.info("Bot config", {
    quantity,
    spreadBps,
    vol,
    riskFreeRate,
    maxInventory: quoteConfig.maxInventory,
    skewFactor: quoteConfig.skewFactor,
  });

  // Build Anchor providers and programs
  const wallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const meridianProgram = new Program<Meridian>(
    MeridianIDL as unknown as Meridian,
    provider,
  );

  const oracleProgram = new Program<MockOracle>(
    MockOracleIDL as unknown as MockOracle,
    provider,
  );

  // Track per-market inventory and error counts
  const inventoryMap = new Map<string, number>(); // marketPubkey -> net inventory
  const errorCountMap = new Map<string, number>(); // marketPubkey -> consecutive errors

  // Determine USDC mint from GlobalConfig
  const [configPda] = findGlobalConfig();
  const globalConfig = await meridianProgram.account.globalConfig.fetch(
    configPda,
  );
  const usdcMint: PublicKey = globalConfig.usdcMint as PublicKey;
  log.info(`USDC mint: ${usdcMint.toBase58()}`);

  // ------ Poll loop ------

  let running = true;
  let isPolling = false; // Guard against overlapping polls (#16)

  async function pollAndQuote(): Promise<void> {
    if (isPolling) {
      log.warn("Poll still in progress, skipping this interval");
      return;
    }
    isPolling = true;
    try {
      // Fetch all StrikeMarket accounts via getProgramAccounts
      const allMarkets =
        await meridianProgram.account.strikeMarket.all();

      const activeMarkets = allMarkets.filter(
        (m) => !m.account.isSettled && !m.account.isPaused,
      );

      log.info(
        `Found ${allMarkets.length} markets, ${activeMarkets.length} active`,
      );

      for (const marketAccount of activeMarkets) {
        const marketKey = marketAccount.publicKey.toBase58();
        const market = marketAccount.account;

        const ticker = decodeTicker(market.ticker as number[]);

        // Read oracle price
        const oracleFeed = market.oracleFeed as PublicKey;
        let spotPrice: number;
        try {
          spotPrice = await readOraclePrice(oracleProgram, oracleFeed);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to read oracle for ${ticker}`, { error: msg });
          continue;
        }

        // Read on-chain token balances for inventory tracking (#1)
        try {
          const [yesMint] = findYesMint(marketAccount.publicKey);
          const [noMint] = findNoMint(marketAccount.publicKey);
          const userYesAta = await getAssociatedTokenAddress(yesMint, admin.publicKey);
          const userNoAta = await getAssociatedTokenAddress(noMint, admin.publicKey);

          let yesBalance = 0;
          let noBalance = 0;
          try {
            const yesAcct = await getAccount(connection, userYesAta);
            yesBalance = Number(yesAcct.amount);
          } catch {
            // ATA doesn't exist yet — balance is 0
          }
          try {
            const noAcct = await getAccount(connection, userNoAta);
            noBalance = Number(noAcct.amount);
          } catch {
            // ATA doesn't exist yet — balance is 0
          }

          inventoryMap.set(marketKey, yesBalance - noBalance);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to read inventory for ${ticker}`, { error: msg });
          // Keep previous inventory value or default to 0
        }

        // Compute time to expiry in years
        const nowUnix = Math.floor(Date.now() / 1000);
        const marketCloseUnix = (market.marketCloseUnix as any).toNumber
          ? (market.marketCloseUnix as any).toNumber()
          : Number(market.marketCloseUnix);
        const T = Math.max(0, (marketCloseUnix - nowUnix) / SECONDS_PER_YEAR);

        // Strike price in dollars
        const strikeLamports = (market.strikePrice as any).toNumber
          ? (market.strikePrice as any).toNumber()
          : Number(market.strikePrice);
        const strikePrice = strikeLamports / 1_000_000;

        // Price the binary option
        const fairProb = binaryCallPrice(spotPrice, strikePrice, vol, T, riskFreeRate);
        const fairCents = probToCents(fairProb);

        // Get current inventory (default 0)
        const inventory = inventoryMap.get(marketKey) ?? 0;

        // Generate quotes
        const quote = generateQuotes(fairProb, inventory, quoteConfig);

        // Circuit breaker check
        const errors = errorCountMap.get(marketKey) ?? 0;
        if (shouldHalt(inventory, quoteConfig.maxInventory, errors)) {
          log.warn(`Circuit breaker HALT for ${ticker}`, {
            inventory,
            errors,
            market: marketKey,
          });
          continue;
        }

        log.info(`${ticker} | spot=$${spotPrice.toFixed(2)} strike=$${strikePrice.toFixed(2)} T=${(T * SECONDS_PER_YEAR / 3600).toFixed(1)}h fair=${fairCents}c bid=${quote.bidPrice}c ask=${quote.askPrice}c inv=${inventory}`);

        // Execute quotes on-chain
        const marketAccounts: MarketAccounts = {
          marketPubkey: marketAccount.publicKey,
          usdcMint,
        };

        try {
          await placeQuotes(
            meridianProgram,
            marketAccounts,
            quote.bidPrice,
            quote.askPrice,
            quantity,
            admin,
          );
          errorCountMap.set(marketKey, 0);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const newErrors = errors + 1;
          errorCountMap.set(marketKey, newErrors);
          log.error(`Quote execution failed for ${ticker} (${newErrors} consecutive)`, {
            error: msg,
            market: marketKey,
          });
        }
      }

      // Evict inventory/error entries for markets that no longer exist
      const activeKeys = new Set(activeMarkets.map((m) => m.publicKey.toBase58()));
      for (const key of inventoryMap.keys()) {
        if (!activeKeys.has(key)) inventoryMap.delete(key);
      }
      for (const key of errorCountMap.keys()) {
        if (!activeKeys.has(key)) errorCountMap.delete(key);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Poll loop error", { error: msg });
    } finally {
      isPolling = false;
    }
  }

  // Run immediately, then on interval
  await pollAndQuote();

  const intervalHandle = setInterval(async () => {
    if (!running) return;
    await pollAndQuote();
  }, POLL_INTERVAL_MS);

  // ------ Graceful shutdown ------

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    log.info(`Received ${signal}, shutting down gracefully`);
    clearInterval(intervalHandle);
    // Allow final logs to flush
    setTimeout(() => process.exit(0), 500);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(`AMM Bot running — polling every ${POLL_INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
}

main().catch((err) => {
  log.critical("Fatal error in amm-bot", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
