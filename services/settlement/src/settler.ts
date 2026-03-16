// ---------------------------------------------------------------------------
// Settlement logic — calls settle_market with oracle retry loop
// ---------------------------------------------------------------------------

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { createLogger } from "../../shared/src/alerting.js";
import { tickerFromBytes } from "../../shared/src/utils.js";
import { findGlobalConfig, findPriceFeed, padTicker } from "../../shared/src/pda.js";

const log = createLogger("settlement:settler");

/** Oracle error codes from the Meridian program */
const ORACLE_STALE_CODE = 6040;
const ORACLE_CONFIDENCE_TOO_WIDE_CODE = 6041;

const SETTLE_RETRY_INTERVAL_MS = 30_000;
const SETTLE_MAX_RETRY_DURATION_MS = 15 * 60 * 1000;

export interface MarketInfo {
  /** On-chain StrikeMarket public key */
  publicKey: PublicKey;
  /** Decoded StrikeMarket account data */
  account: {
    config: PublicKey;
    ticker: number[]; // [u8; 8]
    strikePrice: BN;
    marketCloseUnix: BN;
    isSettled: boolean;
    oracleFeed: PublicKey;
    orderBook: PublicKey;
    escrowVault: PublicKey;
    yesEscrow: PublicKey;
    noEscrow: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    usdcVault: PublicKey;
  };
}

export interface SettlementResult {
  settled: MarketInfo[];
  failed: { market: MarketInfo; error: string }[];
}

// tickerFromBytes re-exported from shared/src/utils for backward compatibility
export { tickerFromBytes } from "../../shared/src/utils.js";

/** Check if an Anchor error matches one of the retryable oracle codes */
function isRetryableOracleError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  // Anchor wraps program errors with error.code or error.error.errorCode.code
  const code =
    (e as any)?.error?.errorCode?.number ??
    (e as any)?.code ??
    (e as any)?.errorCode?.number;

  if (code === ORACLE_STALE_CODE || code === ORACLE_CONFIDENCE_TOO_WIDE_CODE) {
    return true;
  }

  // Fallback: check the message string using the same constants
  const msg = String((e as any)?.message ?? (e as any)?.msg ?? e);
  return (
    msg.includes("OracleStale") ||
    msg.includes("OracleConfidenceTooWide") ||
    msg.includes(String(ORACLE_STALE_CODE)) ||
    msg.includes(String(ORACLE_CONFIDENCE_TOO_WIDE_CODE))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Settle a single market with retry logic for transient oracle errors.
 * Returns true if settled, throws on permanent failure.
 */
async function settleOneMarket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  market: MarketInfo,
): Promise<void> {
  const ticker = tickerFromBytes(market.account.ticker);
  const [configPda] = findGlobalConfig();

  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      log.info(`Settling market ${ticker} (attempt ${attempt})`, {
        market: market.publicKey.toBase58(),
      });

      await program.methods
        .settleMarket()
        .accounts({
          caller: program.provider.publicKey!,
          config: configPda,
          market: market.publicKey,
          oracleFeed: market.account.oracleFeed,
        })
        .rpc();

      log.info(`Market ${ticker} settled successfully`, {
        market: market.publicKey.toBase58(),
        attempts: attempt,
      });
      return;
    } catch (err) {
      if (isRetryableOracleError(err)) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= SETTLE_MAX_RETRY_DURATION_MS) {
          throw new Error(
            `Oracle validation failed for ${ticker} after ${attempt} attempts over ${Math.round(elapsed / 1000)}s: ${err}`,
          );
        }
        log.warn(
          `Oracle validation failed for ${ticker}, retrying in 30s (attempt ${attempt}, ${Math.round(elapsed / 1000)}s elapsed)`,
          { market: market.publicKey.toBase58() },
        );
        await sleep(SETTLE_RETRY_INTERVAL_MS);
        continue;
      }
      // Non-retryable error — bail immediately
      throw err;
    }
  }
}

/**
 * Settle all provided markets that are past close time and not yet settled.
 * For each market:
 *  - Calls settle_market with retry on oracle transient errors
 *  - Alerts admin on permanent failure
 */
export async function settleMarkets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  markets: MarketInfo[],
): Promise<SettlementResult> {
  const result: SettlementResult = { settled: [], failed: [] };
  const now = Math.floor(Date.now() / 1000);

  for (const market of markets) {
    const ticker = tickerFromBytes(market.account.ticker);

    // Skip already-settled markets
    if (market.account.isSettled) {
      log.info(`Market ${ticker} already settled, skipping`);
      continue;
    }

    // Skip markets whose close time hasn't passed
    const closeUnix = market.account.marketCloseUnix.toNumber();
    if (closeUnix > now) {
      log.info(`Market ${ticker} close time not reached (closes at ${closeUnix}, now ${now}), skipping`);
      continue;
    }

    try {
      await settleOneMarket(program, market);
      result.settled.push(market);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.critical(`Settlement failed for ${ticker}: ${errMsg}`, {
        market: market.publicKey.toBase58(),
        ticker,
      });
      result.failed.push({ market, error: errMsg });
    }
  }

  return result;
}

/**
 * Admin-settle markets whose tickers failed price confirmation.
 * Uses the last known price from Yahoo Finance as the settlement price.
 * This is the fallback path — only called when oracle-based settlement times out.
 */
export async function adminSettleMarkets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  markets: MarketInfo[],
  lastKnownPrices: Map<string, number>,
): Promise<SettlementResult> {
  const result: SettlementResult = { settled: [], failed: [] };
  const [configPda] = findGlobalConfig();

  for (const market of markets) {
    const ticker = tickerFromBytes(market.account.ticker);
    if (market.account.isSettled) continue;

    const price = lastKnownPrices.get(ticker);
    if (!price || price <= 0) {
      log.critical(`No last-known price for ${ticker} — cannot admin_settle`);
      result.failed.push({ market, error: "No last-known price for admin_settle" });
      continue;
    }

    const priceLamports = Math.round(price * 1_000_000);

    try {
      log.info(`Admin-settling ${ticker} with last-known price $${price.toFixed(2)}`);
      await program.methods
        .adminSettle(new BN(priceLamports))
        .accounts({
          admin: program.provider.publicKey!,
          config: configPda,
          market: market.publicKey,
        })
        .rpc();

      log.info(`Admin-settled ${ticker} successfully`);
      result.settled.push(market);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // AdminSettleTooEarly means the delay hasn't passed yet — retry on next cycle
      if (errMsg.includes("AdminSettleTooEarly")) {
        log.warn(`Admin settle too early for ${ticker} — will retry next cycle`);
      } else {
        log.critical(`Admin settle failed for ${ticker}: ${errMsg}`);
      }
      result.failed.push({ market, error: errMsg });
    }
  }

  return result;
}
