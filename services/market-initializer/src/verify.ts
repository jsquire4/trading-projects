#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Market Initializer — Verification stub
//
// Checks that today's strike markets exist on-chain for all active tickers.
// Spawned by the scheduler at 8:30 AM ET (30 min after market-initializer).
//
// Exit 0 = all markets found, Exit 1 = missing markets or error.
// ---------------------------------------------------------------------------

import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { createLogger } from "../../shared/src/alerting.js";
import {
  findGlobalConfig,
  findStrikeMarket,
} from "../../shared/src/pda.js";
import { computeMarketCloseUnix } from "./initializer.js";
import { generateVolAwareStrikes } from "./strikeSelector.js";
import { TradierClient } from "../../shared/src/tradier-client.js";

import type { Meridian } from "../../shared/src/idl/meridian.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };

const log = createLogger("market-initializer:verify");

async function main(): Promise<void> {
  log.info("Market verification starting");

  // ---- Environment ---------------------------------------------------------
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const adminSecret = process.env.ADMIN_KEYPAIR;
  if (!adminSecret) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

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

  // ---- Load GlobalConfig via IDL fetch -------------------------------------
  const [configPda] = findGlobalConfig();
  const globalConfig = await (program.account as any).globalConfig.fetch(
    configPda,
  );

  const tickerCount = (globalConfig.tickerCount as number) ?? 0;
  const tickerArrays = globalConfig.tickers as number[][];
  const activeTickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const t = Buffer.from(tickerArrays[i])
      .toString("utf-8")
      .replace(/\0+$/, "");
    if (t.length > 0) activeTickers.push(t);
  }

  if (activeTickers.length === 0) {
    log.warn("No active tickers in GlobalConfig — nothing to verify");
    process.exit(0);
  }

  log.info(`Verifying markets for: ${activeTickers.join(", ")}`);

  // ---- Compute today's market close timestamp ------------------------------
  const marketCloseUnix = computeMarketCloseUnix();

  // ---- Fetch previous close prices for strike calculation ------------------
  const tradier = new TradierClient();
  const quotes = await tradier.getQuotes(activeTickers);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  // ---- Verify each ticker's strike markets exist on-chain ------------------
  let totalExpected = 0;
  let totalFound = 0;
  let totalMissing = 0;
  const missingDetails: string[] = [];

  for (const ticker of activeTickers) {
    const quote = quoteMap.get(ticker);
    if (!quote || !quote.prevclose || quote.prevclose <= 0) {
      log.warn(`No valid quote for ${ticker}, skipping verification`);
      continue;
    }

    // Fetch history for vol-aware strikes (same logic as initializer)
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 90);
    const bars = await tradier.getHistory(
      ticker,
      "daily",
      startDate.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
    );

    const { strikes } = generateVolAwareStrikes(quote.prevclose, bars);

    for (const strikeDollars of strikes) {
      totalExpected++;
      const strikeLamports = BigInt(strikeDollars) * BigInt(10 ** 6);
      const [marketPda] = findStrikeMarket(
        ticker,
        strikeLamports,
        marketCloseUnix,
      );

      const accountInfo = await connection.getAccountInfo(marketPda);
      if (accountInfo !== null) {
        totalFound++;
      } else {
        totalMissing++;
        missingDetails.push(`${ticker} @ $${strikeDollars}`);
      }
    }
  }

  log.info("Verification complete", {
    totalExpected,
    totalFound,
    totalMissing,
  });

  if (totalMissing > 0) {
    log.error(`${totalMissing} market(s) missing on-chain`, {
      missing: missingDetails,
    });
    process.exit(1);
  }

  log.info("All expected markets found on-chain");
  process.exit(0);
}

main().catch((err) => {
  log.critical("Fatal error in market verification", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
