/**
 * Automation Scheduler — Entry Point
 *
 * Long-running service that orchestrates daily market-initializer and
 * settlement triggers on a DST-aware ET schedule.
 *
 * Schedule (all times America/New_York):
 *   08:00  Trigger market-initializer
 *   08:30  Verify markets created
 *   16:05  Trigger settlement service
 *   16:10  Verify settlement completed
 */

import { createLogger } from "../../shared/src/alerting.js";
import { Scheduler } from "./scheduler.js";

const log = createLogger("automation-scheduler");

async function main(): Promise<void> {
  log.info("=== Meridian Automation Scheduler ===");
  log.info(`PID: ${process.pid}`);
  log.info(`Node: ${process.version}`);
  log.info(`RPC_URL: ${process.env.RPC_URL ? "set" : "NOT SET"}`);
  log.info(`MARKET_DATA_SOURCE: ${process.env.MARKET_DATA_SOURCE ?? "live (Yahoo Finance)"}`);
  log.info(`ADMIN_KEYPAIR: ${process.env.ADMIN_KEYPAIR ? "set" : "NOT SET"}`);

  const scheduler = new Scheduler();

  // Graceful shutdown
  const shutdown = () => {
    log.info("Received shutdown signal — stopping scheduler");
    scheduler.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Handle unhandled rejections so the service doesn't silently die
  process.on("unhandledRejection", (err) => {
    log.error("Unhandled rejection in scheduler", { error: String(err) });
  });

  await scheduler.start();

  // Keep the process alive — the scheduler uses setTimeout internally
  // Node will stay alive as long as there are active timers
  log.info("Scheduler is running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  log.critical("Scheduler failed to start", { error: String(err) });
  process.exit(1);
});
