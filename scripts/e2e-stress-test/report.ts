/**
 * report.ts — Report writer and console summary for the E2E Stress Test.
 *
 * Writes both HTML (via report-template) and JSON artifacts,
 * and prints a concise console summary.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { E2EReport } from "./types";
import { renderHtmlReport } from "./report-template";

// ─── JSON serialization helpers ───────────────────────────────────────────────

/**
 * Custom JSON replacer that handles bigint, Map, and Set.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

// ─── writeReport ──────────────────────────────────────────────────────────────

/**
 * Write HTML and JSON report files to the output directory.
 * Returns the path to the HTML file.
 */
export async function writeReport(
  report: E2EReport,
  outputDir: string,
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });

  const baseName = `really-stressful-test-${report.runId}`;

  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const jsonPath = path.join(outputDir, `${baseName}.json`);

  const html = renderHtmlReport(report);
  await fs.writeFile(htmlPath, html, "utf-8");

  const json = JSON.stringify(report, jsonReplacer, 2);
  await fs.writeFile(jsonPath, json, "utf-8");

  return htmlPath;
}

// ─── printConsoleSummary ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function actDuration(act: { duration: number }): string {
  return formatDuration(act.duration);
}

/**
 * Print a concise summary to the console.
 */
export function printConsoleSummary(report: E2EReport): void {
  const totalDuration = report.endMs - report.startMs;
  const bar = "\u2550".repeat(67);
  const verdict = report.verdict;
  const tag = verdict === "PASS" ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";

  console.log();
  console.log(bar);
  console.log(
    `  REALLY STRESSFUL TEST — ${tag}`,
  );
  console.log(
    `  Duration: ${formatDuration(totalDuration)} | ` +
      `Seed: ${report.config.seed} | ` +
      `Agents: ${report.config.numAgents} | ` +
      `Days: ${report.config.numDays}`,
  );
  console.log(bar);

  // Acts
  const actNames = ["Correctness", "User Flows", "Simulation"];
  for (let i = 0; i < report.acts.length; i++) {
    const act = report.acts[i];
    const label = actNames[i] ?? act.name;
    const status = act.passed
      ? "\x1b[32mPASS\x1b[0m"
      : "\x1b[31mFAIL\x1b[0m";
    const padded = `Act ${i + 1}: ${label}`.padEnd(35, " .");
    console.log(`  ${padded} ${status} (${actDuration(act)})`);
  }

  // Acceptance criteria
  console.log();
  console.log("  Acceptance Criteria:");
  for (const ac of report.acceptanceCriteria) {
    const icon = ac.passed ? "\x1b[32m[✓]\x1b[0m" : "\x1b[31m[✗]\x1b[0m";
    console.log(`  ${icon} ${ac.id}: ${ac.description} (actual: ${ac.actual})`);
  }

  // Error count
  console.log();
  console.log(`  Errors: ${report.errors.length} total`);
  console.log(bar);
  console.log();
}
