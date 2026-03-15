/**
 * Scheduler — daily health check watchdog.
 *
 * Market creation is intentionally triggered post-settlement (~4:05 PM ET),
 * not at 8 AM. This is a deliberate design choice: binary markets for the
 * next trading day open immediately after the previous day's settlement
 * clears, allowing overnight/weekend trading against the next close.
 *
 * The 8:30 AM morning job exists as a safety net — it verifies that markets
 * were created successfully by the post-settlement initializer. If markets
 * are missing (settlement pipeline failed overnight), it triggers creation
 * as a fallback. Under normal operation, this job finds all markets already
 * present and exits cleanly.
 *
 * This is observe-only unless markets are missing — it never blocks or
 * modifies on-chain state during normal operation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../shared/src/alerting.js";
import { getNextETTime, isMarketDay, getTodayET } from "./timezone.js";

const log = createLogger("automation-scheduler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_ROOT = resolve(__dirname, "..", "..");

export class Scheduler {
  private running = false;
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRunDate: string | null = null;

  async start(): Promise<void> {
    this.running = true;
    log.info("Scheduler starting (watchdog mode — morning health check only)");
    await this.scheduleHealthCheck();
    this.scheduleMidnightRecalc();
    log.info("Scheduler started — waiting for next health check");
  }

  stop(): void {
    this.running = false;
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    log.info("Scheduler stopped");
  }

  private async scheduleHealthCheck(): Promise<void> {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // 8:30 AM ET daily
    const nextRun = getNextETTime(8, 30);
    const delayMs = nextRun.getTime() - Date.now();

    if (delayMs <= 0) {
      log.warn("Health check time is in the past, skipping to tomorrow");
      return;
    }

    const delayHrs = (delayMs / 3_600_000).toFixed(1);
    log.info(`Next health check: ${nextRun.toISOString()} (in ${delayHrs}h)`);

    this.healthCheckTimer = setTimeout(() => this.runHealthCheck(), delayMs);
  }

  private async runHealthCheck(): Promise<void> {
    if (!this.running) return;

    const todayET = getTodayET();

    // Prevent double execution
    if (this.lastRunDate === todayET) {
      log.warn(`Health check already ran today (${todayET}), skipping`);
      this.reschedule();
      return;
    }

    const marketDay = await isMarketDay();
    if (!marketDay) {
      log.info(`Skipping health check — not a market day (${todayET})`);
      this.lastRunDate = todayET;
      this.reschedule();
      return;
    }

    log.info(`Running morning health check for ${todayET}`);

    try {
      // Run the verification script (read-only, alert-only)
      const verifyScript = resolve(SERVICES_ROOT, "market-initializer/src/verify.ts");
      const tsxPath = resolve(SERVICES_ROOT, "node_modules/.bin/tsx");

      await new Promise<void>((resolveP, rejectP) => {
        const child = spawn(tsxPath, [verifyScript], {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout: string[] = [];
        const stderr: string[] = [];

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout.push(text);
          for (const line of text.split("\n").filter(Boolean)) {
            log.info(`[verify] ${line}`);
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk.toString());
        });

        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          rejectP(new Error("Verification timed out after 2 minutes"));
        }, 2 * 60 * 1000);

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolveP();
          } else {
            rejectP(new Error(`Verification exited with code ${code}: ${stderr.join("")}`));
          }
        });
      });

      log.info("Morning health check passed — markets verified");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.critical(`Morning health check FAILED: ${msg} — attempting fallback market creation`, { date: todayET });

      // Fallback: if verification failed (markets missing), run market-initializer
      try {
        const initScript = resolve(SERVICES_ROOT, "market-initializer/src/index.ts");
        const tsxPath2 = resolve(SERVICES_ROOT, "node_modules/.bin/tsx");
        await new Promise<void>((resolveP, rejectP) => {
          const child = spawn(tsxPath2, [initScript], {
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout?.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
              log.info(`[fallback-init] ${line}`);
            }
          });
          const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            rejectP(new Error("Fallback market creation timed out after 5 minutes"));
          }, 5 * 60 * 1000);
          child.on("close", (code) => {
            clearTimeout(timeout);
            if (code === 0) resolveP();
            else rejectP(new Error(`Fallback init exited with code ${code}`));
          });
        });
        log.info("Fallback market creation completed");
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        log.critical(`Fallback market creation also failed: ${fbMsg}`, { date: todayET });
      }
    }

    this.lastRunDate = todayET;
    this.reschedule();
  }

  private reschedule(): void {
    if (!this.running) return;
    this.scheduleHealthCheck();
  }

  private scheduleMidnightRecalc(): void {
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
    }
    const midnight = getNextETTime(0, 1);
    const delayMs = midnight.getTime() - Date.now();

    this.midnightTimer = setTimeout(async () => {
      if (!this.running) return;
      log.info("Midnight recalculation — rescheduling health check");
      await this.scheduleHealthCheck();
      this.scheduleMidnightRecalc();
    }, delayMs);
  }
}
