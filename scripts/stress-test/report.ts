/**
 * report.ts — Console report with per-phase stats and acceptance criteria.
 */

import type { PhaseStats } from "./config";

export interface StressTestReport {
  startMs: number;
  endMs: number;
  numWallets: number;
  numMarkets: number;
  phases: PhaseStats[];
  marketsCreated: number;
  marketsSettled: number;
  marketsClosed: number;
  vaultViolations: number;
  instructionTypesExercised: number;
  totalInstructionTypes: number;
  overrideWindowActive: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs - mins * 60;
  return `${mins}m${remSecs.toFixed(1)}s`;
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function padN(n: number, w: number): string {
  return String(n).padStart(w);
}

export function printReport(report: StressTestReport): boolean {
  const totalDuration = report.endMs - report.startMs;
  const totalTxns = report.phases.reduce((s, p) => s + p.attempted, 0);
  const totalSucceeded = report.phases.reduce((s, p) => s + p.succeeded, 0);

  console.log("");
  console.log("=".repeat(80));
  console.log("MERIDIAN STRESS TEST REPORT");
  console.log("=".repeat(80));
  console.log(`Duration        : ${formatDuration(totalDuration)}`);
  console.log(`Wallets         : ${report.numWallets}`);
  console.log(`Markets         : ${report.numMarkets} (7 tickers × 3 strikes)`);
  console.log(`Total txns      : ${totalTxns.toLocaleString()}`);
  console.log("");

  // Phase table
  console.log(
    `${pad("Phase", 6)} ${pad("Name", 22)} ${pad("Attempted", 11)} ${pad("Succeeded", 11)} ${pad("Failed", 8)} ${pad("Duration", 10)}`,
  );
  console.log(
    `${"-".repeat(5)}  ${"-".repeat(20)}  ${"-".repeat(9)}  ${"-".repeat(9)}  ${"-".repeat(6)}  ${"-".repeat(8)}`,
  );

  for (let i = 0; i < report.phases.length; i++) {
    const p = report.phases[i];
    const dur = formatDuration(p.endMs - p.startMs);
    console.log(
      `${pad(String(i + 1), 6)} ${pad(p.name, 22)} ${padN(p.attempted, 9)}  ${padN(p.succeeded, 9)}  ${padN(p.failed, 6)}  ${pad(dur, 8)}`,
    );
  }

  console.log("");

  // Acceptance criteria
  console.log("Acceptance Criteria");
  console.log("-".repeat(60));

  const criteria: { id: string; desc: string; value: string; pass: boolean | "SKIP" }[] = [];

  // AC-1: All 21 markets created
  criteria.push({
    id: "AC-1",
    desc: "All 21 markets created",
    value: `${report.marketsCreated}/21`,
    pass: report.marketsCreated >= 21,
  });

  // AC-2: Order success rate >= 80%
  const tradingPhase = report.phases.find((p) => p.name === "Trading");
  const orderSuccessRate = tradingPhase && tradingPhase.attempted > 0
    ? (tradingPhase.succeeded / tradingPhase.attempted) * 100
    : 0;
  criteria.push({
    id: "AC-2",
    desc: "Order success rate >= 80%",
    value: `${orderSuccessRate.toFixed(1)}%`,
    pass: orderSuccessRate >= 80,
  });

  // AC-3: All 7 lifecycle markets settled
  criteria.push({
    id: "AC-3",
    desc: "All 7 lifecycle markets settled",
    value: `${report.marketsSettled}/7`,
    pass: report.marketsSettled >= 7,
  });

  // AC-4: Lifecycle markets closed
  criteria.push({
    id: "AC-4",
    desc: "Lifecycle markets closed",
    value: report.overrideWindowActive
      ? `${report.marketsClosed}/7 (override window)`
      : `${report.marketsClosed}/7`,
    pass: report.overrideWindowActive ? "SKIP" : report.marketsClosed >= 7,
  });

  // AC-5: Zero vault invariant violations
  criteria.push({
    id: "AC-5",
    desc: "Zero vault invariant violations",
    value: String(report.vaultViolations),
    pass: report.vaultViolations === 0,
  });

  // AC-6: Total txn count > 500
  criteria.push({
    id: "AC-6",
    desc: "Total txn count > 500",
    value: totalTxns.toLocaleString(),
    pass: totalTxns > 500,
  });

  // AC-7: Instruction types exercised
  criteria.push({
    id: "AC-7",
    desc: `Instruction types exercised`,
    value: `${report.instructionTypesExercised}/${report.totalInstructionTypes}`,
    pass: report.instructionTypesExercised >= 10,
  });

  let allPassed = true;
  let hasSkips = false;
  for (const c of criteria) {
    const status = c.pass === "SKIP" ? "SKIP" : c.pass ? "PASS" : "FAIL";
    if (c.pass === false) allPassed = false;
    if (c.pass === "SKIP") hasSkips = true;
    console.log(`${c.id}  ${pad(c.desc, 38)} ${pad(c.value, 12)} ${status}`);
  }

  console.log("");

  if (allPassed) {
    console.log(`OVERALL: PASS${hasSkips ? " (with skips)" : ""}`);
  } else {
    console.log("OVERALL: FAIL");
  }
  console.log("=".repeat(80));

  // Print top errors
  const allErrors = report.phases.flatMap((p) => p.errors);
  if (allErrors.length > 0) {
    console.log(`\nTop errors (${allErrors.length} total):`);
    const shown = allErrors.slice(0, 10);
    for (const e of shown) {
      console.log(`  - ${e}`);
    }
    if (allErrors.length > 10) {
      console.log(`  ... and ${allErrors.length - 10} more`);
    }
  }

  return allPassed;
}
