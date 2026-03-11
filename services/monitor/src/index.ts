// ---------------------------------------------------------------------------
// Monitor Service — continuous polling loop for health checks
//
// Checks:
//   1. Admin SOL balance (alert if < 0.1 SOL)
//   2. Oracle freshness (alert if stale during market hours)
//   3. Unsettled expired markets
//   4. Closeable markets (settled + 90 days elapsed)
// ---------------------------------------------------------------------------

import "dotenv/config";
import { createLogger } from "../../shared/src/alerting.js";
import { runChecks } from "./checker.js";

const log = createLogger("monitor");

const POLL_INTERVAL_MS = parseInt(
  process.env.POLL_INTERVAL_MS ?? "300000",
  10,
); // default 5 min

let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log.info("=== Monitor Service starting ===", {
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info("Monitor shutting down...");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // First run immediately, then poll
  while (running) {
    try {
      await runChecks();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Monitor check cycle failed: ${errMsg}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }

  log.info("Monitor stopped.");
}

main();
