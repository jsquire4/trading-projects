#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Market Initializer — entry point
//
// One-shot job: fetch Tradier previous close prices, calculate strikes,
// create on-chain strike markets with order books and ALTs.
//
// Designed to run at 8:00 AM ET via scheduler, or manually:
//   npx tsx src/index.ts
// ---------------------------------------------------------------------------

import { createLogger } from "../../shared/src/alerting.ts";
import { initializeMarkets } from "./initializer.ts";

const log = createLogger("market-initializer");

async function main(): Promise<void> {
  log.info("Market Initializer starting");

  const results = await initializeMarkets();

  // ---- Summary -----------------------------------------------------------
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const r of results) {
    totalCreated += r.strikesCreated;
    totalSkipped += r.strikesSkipped;
    totalErrors += r.errors.length;

    const status = r.errors.length > 0 ? "PARTIAL" : "OK";
    log.info(`${r.ticker}: ${status}`, {
      previousClose: r.previousClose,
      created: r.strikesCreated,
      skipped: r.strikesSkipped,
      errors: r.errors.length,
    });
  }

  log.info("Market Initializer complete", {
    tickers: results.length,
    totalCreated,
    totalSkipped,
    totalErrors,
  });

  if (totalErrors > 0) {
    const allErrors = results.flatMap((r) => r.errors);
    log.error(`${totalErrors} error(s) during initialization`, {
      errors: allErrors,
    });
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  log.critical("Fatal error in Market Initializer", {
    error: err.message ?? String(err),
    stack: err.stack,
  });
  process.exit(1);
});
