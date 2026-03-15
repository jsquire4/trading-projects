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

// ---------------------------------------------------------------------------
// Data-driven job configuration
// ---------------------------------------------------------------------------

interface JobConfig {
  id: string;
  hour: number;
  minute: number;
  /** Relative path from SERVICES_ROOT to the entry-point script */
  servicePath: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** If true, log a critical alert on failure instead of a warning */
  criticalOnFailure: boolean;
  /** Human-readable label for log messages */
  label: string;
}

const JOB_CONFIGS: JobConfig[] = [
  {
    id: "morning-init",
    hour: 8,
    minute: 0,
    servicePath: "market-initializer/src/index.ts",
    timeoutMs: 5 * 60 * 1000,
    criticalOnFailure: false,
    label: "market-initializer",
  },
  {
    id: "morning-verify",
    hour: 8,
    minute: 30,
    servicePath: "market-initializer/src/verify.ts",
    timeoutMs: 2 * 60 * 1000,
    criticalOnFailure: true,
    label: "morning verification",
  },
  {
    id: "afternoon-settle",
    hour: 16,
    minute: 5,
    servicePath: "settlement/src/index.ts",
    timeoutMs: 20 * 60 * 1000,
    criticalOnFailure: false,
    label: "settlement",
  },
  {
    id: "afternoon-verify",
    hour: 16,
    minute: 10,
    servicePath: "settlement/src/verify.ts",
    timeoutMs: 2 * 60 * 1000,
    criticalOnFailure: true,
    label: "afternoon verification",
  },
];

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
  private activeChildren: Set<ChildProcess> = new Set();
  /** Tracks which jobs have already run today (by ET date string) */
  private lastRunDate: Map<string, string> = new Map();

  constructor() {
    this.jobs = JOB_CONFIGS.map((cfg) => ({
      id: cfg.id,
      hour: cfg.hour,
      minute: cfg.minute,
      handler: () => this.runJobFromConfig(cfg),
      timer: null,
      nextRun: null,
    }));
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
    for (const child of this.activeChildren) {
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.kill("SIGTERM");
    }
    this.activeChildren.clear();
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
  // Data-driven job runner
  // ---------------------------------------------------------------------------

  private async runJobFromConfig(cfg: JobConfig): Promise<void> {
    log.info(`Triggering ${cfg.label} service`);
    const servicePath = resolve(SERVICES_ROOT, cfg.servicePath);
    try {
      await this.spawnService(cfg.id, servicePath, cfg.timeoutMs);
      log.info(`${cfg.label} completed successfully`);
    } catch {
      if (cfg.criticalOnFailure) {
        log.critical(`${cfg.label.toUpperCase()} FAILED`, {
          date: getTodayET(),
        });
      }
      // Non-critical failures are already logged by spawnService
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

      // Use resolved tsx path to avoid PATH lookup issues in production
      const tsxPath = resolve(__dirname, "../../node_modules/.bin/tsx");
      const child: ChildProcess = spawn(tsxPath, [scriptPath], {
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeChildren.add(child);

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
        this.activeChildren.delete(child);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
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
