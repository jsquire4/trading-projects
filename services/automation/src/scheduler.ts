/**
 * Core Scheduler
 *
 * Manages timed daily jobs with DST-aware ET scheduling.
 * Spawns child services (market-initializer, settlement) and monitors
 * their completion. Recalculates trigger times after midnight ET.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../shared/src/alerting.js";
import { getNextETTime, isMarketDay, getTodayET } from "./timezone.js";

const log = createLogger("automation-scheduler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_ROOT = resolve(__dirname, "..", "..");

// Timeout per job type (ms)
const INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SETTLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

interface ScheduledJob {
  id: string;
  hour: number;
  minute: number;
  handler: () => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  nextRun: Date | null;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private running = false;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tracks which jobs have already run today (by ET date string) */
  private lastRunDate: Map<string, string> = new Map();

  constructor() {
    this.jobs = [
      {
        id: "morning-init",
        hour: 8,
        minute: 0,
        handler: () => this.runMorningInit(),
        timer: null,
        nextRun: null,
      },
      {
        id: "morning-verify",
        hour: 8,
        minute: 30,
        handler: () => this.runMorningVerify(),
        timer: null,
        nextRun: null,
      },
      {
        id: "afternoon-settle",
        hour: 16,
        minute: 5,
        handler: () => this.runAfternoonSettle(),
        timer: null,
        nextRun: null,
      },
      {
        id: "afternoon-verify",
        hour: 16,
        minute: 10,
        handler: () => this.runAfternoonVerify(),
        timer: null,
        nextRun: null,
      },
    ];
  }

  /**
   * Start the scheduler. Calculates next trigger times and sets timers.
   */
  async start(): Promise<void> {
    this.running = true;
    log.info("Scheduler starting");
    await this.scheduleAllJobs();
    this.scheduleMidnightRecalc();
    this.logNextEvents();
    log.info("Scheduler started — waiting for next trigger");
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    this.running = false;
    for (const job of this.jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    log.info("Scheduler stopped");
  }

  /**
   * Schedule all jobs by computing their next ET trigger times.
   */
  private async scheduleAllJobs(): Promise<void> {
    for (const job of this.jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }

      const nextRun = getNextETTime(job.hour, job.minute);
      job.nextRun = nextRun;

      const delayMs = nextRun.getTime() - Date.now();
      if (delayMs <= 0) {
        // Shouldn't happen since getNextETTime returns future times, but guard anyway
        log.warn(`Job ${job.id} next run is in the past, skipping to tomorrow`);
        continue;
      }

      job.timer = setTimeout(() => this.executeJob(job), delayMs);
    }
  }

  /**
   * Schedule a recalculation after midnight ET to handle DST transitions
   * and roll over to the next trading day.
   */
  private scheduleMidnightRecalc(): void {
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
    }
    // Schedule for 00:01 AM ET (1 minute past midnight)
    const midnight = getNextETTime(0, 1);
    const delayMs = midnight.getTime() - Date.now();

    this.midnightTimer = setTimeout(async () => {
      if (!this.running) return;
      log.info("Midnight recalculation — rescheduling all jobs for new trading day");
      await this.scheduleAllJobs();
      this.scheduleMidnightRecalc();
      this.logNextEvents();
    }, delayMs);
  }

  /**
   * Execute a scheduled job. Checks if today is a market day first.
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    if (!this.running) return;

    const todayET = getTodayET();

    // Prevent double execution on the same ET date
    if (this.lastRunDate.get(job.id) === todayET) {
      log.warn(`Job ${job.id} already ran today (${todayET}), skipping`);
      this.rescheduleJob(job);
      return;
    }

    // Check if today is a trading day
    const marketDay = await isMarketDay();
    if (!marketDay) {
      log.info(`Skipping ${job.id} — not a market day`, { date: todayET });
      this.lastRunDate.set(job.id, todayET);
      this.rescheduleJob(job);
      return;
    }

    log.info(`Executing job: ${job.id}`, { scheduledTime: job.nextRun?.toISOString() });

    try {
      await job.handler();
      this.lastRunDate.set(job.id, todayET);
    } catch (err) {
      log.error(`Job ${job.id} failed with unhandled error`, {
        error: String(err),
      });
    }

    // Reschedule for the next occurrence
    this.rescheduleJob(job);
  }

  /**
   * After a job runs, recalculate its next trigger time.
   */
  private rescheduleJob(job: ScheduledJob): void {
    if (!this.running) return;

    const nextRun = getNextETTime(job.hour, job.minute);
    job.nextRun = nextRun;

    const delayMs = nextRun.getTime() - Date.now();
    job.timer = setTimeout(() => this.executeJob(job), delayMs);

    log.info(`Rescheduled ${job.id}`, { nextRun: nextRun.toISOString() });
  }

  /**
   * Log upcoming events for visibility.
   */
  private logNextEvents(): void {
    const sorted = [...this.jobs]
      .filter((j) => j.nextRun)
      .sort((a, b) => a.nextRun!.getTime() - b.nextRun!.getTime());

    log.info("Upcoming schedule:");
    for (const job of sorted) {
      const delayHrs = (
        (job.nextRun!.getTime() - Date.now()) /
        3_600_000
      ).toFixed(1);
      log.info(`  ${job.id} → ${job.nextRun!.toISOString()} (in ${delayHrs}h)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Job implementations
  // ---------------------------------------------------------------------------

  private async runMorningInit(): Promise<void> {
    log.info("Triggering market-initializer service");
    const servicePath = resolve(SERVICES_ROOT, "market-initializer", "src", "index.ts");
    await this.spawnService("market-initializer", servicePath, INIT_TIMEOUT_MS);
  }

  private async runMorningVerify(): Promise<void> {
    log.info("Verifying markets were created");
    // Verification: attempt to connect to RPC and check for today's markets.
    // If the market-initializer wrote a status file or the on-chain state shows
    // markets, we consider it a success. For now, we spawn a lightweight verify
    // script; if no dedicated verifier exists, we log a warning.
    const servicePath = resolve(SERVICES_ROOT, "market-initializer", "src", "verify.ts");
    try {
      await this.spawnService("morning-verify", servicePath, VERIFY_TIMEOUT_MS);
      log.info("Morning verification passed — markets created");
    } catch {
      log.critical("MORNING VERIFICATION FAILED — markets may not have been created", {
        date: getTodayET(),
      });
    }
  }

  private async runAfternoonSettle(): Promise<void> {
    log.info("Triggering settlement service");
    const servicePath = resolve(SERVICES_ROOT, "settlement", "src", "index.ts");
    await this.spawnService("settlement", servicePath, SETTLE_TIMEOUT_MS);
  }

  private async runAfternoonVerify(): Promise<void> {
    log.info("Verifying markets were settled");
    const servicePath = resolve(SERVICES_ROOT, "settlement", "src", "verify.ts");
    try {
      await this.spawnService("afternoon-verify", servicePath, VERIFY_TIMEOUT_MS);
      log.info("Afternoon verification passed — markets settled");
    } catch {
      log.critical("AFTERNOON VERIFICATION FAILED — markets may remain unsettled", {
        date: getTodayET(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Child process management
  // ---------------------------------------------------------------------------

  /**
   * Spawn a child service via `npx tsx <path>` and wait for it to exit.
   * Captures stdout/stderr, enforces a timeout, and alerts on failure.
   */
  private spawnService(
    name: string,
    scriptPath: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolveP, rejectP) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let settled = false;

      const child: ChildProcess = spawn("npx", ["tsx", scriptPath], {
        env: {
          ...process.env,
          // Ensure child inherits relevant env vars
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          // Give it 5s to terminate gracefully, then SIGKILL
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 5_000);
          const msg = `Service ${name} timed out after ${timeoutMs / 1000}s`;
          log.error(msg, { stdout: stdoutChunks.join("").slice(-2000) });
          rejectP(new Error(msg));
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        // Stream child output to parent stdout with prefix
        for (const line of text.split("\n").filter(Boolean)) {
          log.info(`[${name}] ${line}`);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        for (const line of text.split("\n").filter(Boolean)) {
          log.warn(`[${name}:stderr] ${line}`);
        }
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          log.error(`Failed to spawn ${name}`, { error: String(err) });
          rejectP(err);
        }
      });

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          if (code === 0) {
            log.info(`Service ${name} completed successfully`);
            resolveP();
          } else {
            const stderr = stderrChunks.join("").slice(-2000);
            log.error(`Service ${name} exited with code ${code}`, {
              exitCode: code,
              stderr,
            });
            rejectP(new Error(`${name} exited with code ${code}`));
          }
        }
      });
    });
  }
}
