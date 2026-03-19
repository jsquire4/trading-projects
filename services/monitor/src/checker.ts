// ---------------------------------------------------------------------------
// Health checks — called each poll cycle by the monitor service
// ---------------------------------------------------------------------------

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { createLogger } from "../../shared/src/alerting.js";
import { tickerFromBytes } from "../../shared/src/utils.js";
import meridianIdl from "../../shared/src/idl/meridian.json" with { type: "json" };
import {
  findGlobalConfig,
  findPriceFeed,
  padTicker,
  MERIDIAN_PROGRAM_ID,
} from "../../shared/src/pda.js";

const log = createLogger("monitor");

// Read-only provider — keypair is only used to satisfy AnchorProvider's wallet
// requirement; it never signs any transactions.
const _readOnlyKeypair = Keypair.generate();

const MIN_ADMIN_SOL = 0.1;
const ORACLE_STALE_THRESHOLD_S = 10 * 60; // 10 minutes

/** Check if current time is within US market hours (M-F 9:30-16:00 ET). */
function isDuringMarketHours(): boolean {
  const now = new Date();
  // Use Intl.DateTimeFormat.formatToParts for spec-safe timezone parsing
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "0";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const day = weekdayMap[get("weekday")] ?? 0;
  if (day === 0 || day === 6) return false;

  const totalMinutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  // 9:30 = 570 min, 16:00 = 960 min
  return totalMinutes >= 570 && totalMinutes <= 960;
}

export async function runChecks(): Promise<void> {
  const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(RPC_URL, "confirmed");

  // Minimal wallet — monitor is read-only, no signing needed
  const wallet = new Wallet(_readOnlyKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(meridianIdl as any, provider);

  const [configPda] = findGlobalConfig();
  const globalConfig = await program.account.globalConfig.fetch(configPda);

  const now = Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------
  // Check 1: Admin SOL balance
  // ------------------------------------------------------------------
  const admin = globalConfig.admin as PublicKey;
  const adminBalance = await connection.getBalance(admin);
  const adminSol = adminBalance / LAMPORTS_PER_SOL;

  if (adminSol < MIN_ADMIN_SOL) {
    log.critical(`Admin SOL balance critically low: ${adminSol.toFixed(4)} SOL`, {
      admin: admin.toBase58(),
      balance: adminSol,
      threshold: MIN_ADMIN_SOL,
    });
  } else {
    log.info(`Admin SOL balance: ${adminSol.toFixed(4)} SOL`, {
      admin: admin.toBase58(),
    });
  }

  // ------------------------------------------------------------------
  // Check 2: Oracle freshness (only during market hours)
  // ------------------------------------------------------------------
  const tickerCount = (globalConfig.tickerCount as number) ?? 0;
  const tickerArrays = globalConfig.tickers as number[][];
  const activeTickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const t = tickerFromBytes(tickerArrays[i]);
    if (t.length > 0) activeTickers.push(t);
  }

  if (isDuringMarketHours()) {
    for (const ticker of activeTickers) {
      try {
        const [priceFeedPda] = findPriceFeed(ticker);
        const feedAccount = await connection.getAccountInfo(priceFeedPda);
        if (!feedAccount) {
          log.error(`Oracle price feed not found for ${ticker}`, {
            pda: priceFeedPda.toBase58(),
          });
          continue;
        }

        // PriceFeed layout: disc(8) + ticker(8) + price(8) + confidence(8) + timestamp(8)
        // Timestamp is at byte offset 8+8+8+8 = 32 from start of account data.
        const data = feedAccount.data;
        const timestamp = Number(data.readBigInt64LE(8 + 8 + 8 + 8));

        const age = now - timestamp;
        if (age > ORACLE_STALE_THRESHOLD_S) {
          log.error(`Oracle stale for ${ticker}: last update ${age}s ago (threshold ${ORACLE_STALE_THRESHOLD_S}s)`, {
            ticker,
            lastUpdate: timestamp,
            ageSeconds: age,
          });
        } else {
          log.info(`Oracle ${ticker}: fresh (${age}s ago)`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to check oracle for ${ticker}: ${errMsg}`);
      }
    }
  } else {
    log.info("Outside market hours — skipping oracle freshness check");
  }

  // ------------------------------------------------------------------
  // Check 3: Unsettled expired markets
  // ------------------------------------------------------------------
  const allMarkets = await program.account.strikeMarket.all();
  const unsettledExpired = allMarkets.filter((m) => {
    const isSettled = m.account.isSettled as boolean;
    const closeUnix = (m.account.marketCloseUnix as BN).toNumber();
    return !isSettled && closeUnix < now;
  });

  if (unsettledExpired.length > 0) {
    for (const m of unsettledExpired) {
      const ticker = tickerFromBytes(m.account.ticker as number[]);
      const closeUnix = (m.account.marketCloseUnix as BN).toNumber();
      const hoursOverdue = ((now - closeUnix) / 3600).toFixed(1);
      log.warn(`Unsettled expired market: ${ticker} (expired ${hoursOverdue}h ago)`, {
        market: m.publicKey.toBase58(),
        closeUnix,
      });
    }
  } else {
    log.info("No unsettled expired markets");
  }

  // ------------------------------------------------------------------
  // Check 4: Closeable markets (override deadline passed — matches closer.ts)
  // ------------------------------------------------------------------
  const closeable = allMarkets.filter((m) => {
    const isSettled = m.account.isSettled as boolean;
    const overrideDeadline = (m.account.overrideDeadline as BN | undefined)?.toNumber?.() ?? 0;
    return isSettled && overrideDeadline > 0 && overrideDeadline < now;
  });

  if (closeable.length > 0) {
    for (const m of closeable) {
      const ticker = tickerFromBytes(m.account.ticker as number[]);
      const overrideDeadline = (m.account.overrideDeadline as BN | undefined)?.toNumber?.() ?? 0;
      const secsSinceDeadline = now - overrideDeadline;
      log.info(`Market eligible for close: ${ticker} (override deadline passed ${secsSinceDeadline}s ago)`, {
        market: m.publicKey.toBase58(),
        overrideDeadline,
      });
    }
  } else {
    log.info("No markets eligible for closing");
  }

  log.info("Health check cycle complete");
}
