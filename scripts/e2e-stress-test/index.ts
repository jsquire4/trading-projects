/**
 * index.ts — E2E Stress Test entry point.
 *
 * Usage:
 *   npx ts-node scripts/e2e-stress-test/index.ts [options]
 *
 * Options:
 *   --seed <n>              Seed for deterministic RNG (default: 42)
 *   --agents <n>            Number of trading agents (default: 20)
 *   --days <n>              Number of simulated trading days (default: 2)
 *   --close-offset <sec>    Seconds until market close per day (default: 240)
 *   --trading-window <sec>  Seconds agents trade before close (default: 180)
 *   --concurrency <n>       Max parallel resting txns (default: 10)
 *   --tickers <csv>         Comma-separated tickers (default: all 7)
 *   --rpc <url>             RPC endpoint (default: http://127.0.0.1:8899)
 *   --output <dir>          Report output directory (default: ./stress-reports)
 *   --skip-acts <csv>       Acts to skip, e.g. "2,3" (default: none)
 */

import type { ActResult, AcceptanceCriterion, E2EReport } from "./types";
import { parseCliArgs, buildConfig } from "./config";
import { setupTestEnvironment } from "./setup";
import { runAct1 } from "./act1-correctness";
import { runAct2 } from "./act2-user-flows";
import { runAct3 } from "./act3-simulation";
import { writeReport, printConsoleSummary } from "./report";

async function main(): Promise<void> {
  const config = buildConfig(parseCliArgs(process.argv.slice(2)));

  console.log("=".repeat(70));
  console.log("  MERIDIAN — REALLY STRESSFUL TEST");
  console.log("=".repeat(70));
  console.log(`  Seed: ${config.seed} | Agents: ${config.numAgents} | Days: ${config.numDays}`);
  console.log(`  Tickers: ${config.tickers.join(", ")}`);
  console.log(`  RPC: ${config.rpcUrl}`);
  console.log(`  Close offset: ${config.marketCloseOffsetSec}s | Trading window: ${config.tradingWindowSec}s`);
  if (config.skipActs.length > 0) {
    console.log(`  Skipping acts: ${config.skipActs.join(", ")}`);
  }
  console.log("=".repeat(70));

  console.log("\n[Setup] Initializing...");
  const ctx = await setupTestEnvironment(config);
  console.log(`  ${ctx.agents.length} agents funded`);
  console.log(`  Config PDA: ${ctx.configPda.toBase58()}`);

  const startMs = Date.now();
  const acts: ActResult[] = [];

  // Act 1: Correctness Gate
  if (!config.skipActs.includes(1)) {
    console.log("\n[Act 1] Correctness Gate — proving every instruction type works...");
    const result = await runAct1(ctx);
    acts.push(result);
    const badge = result.passed ? "PASS" : "FAIL";
    console.log(`  Act 1: ${badge} (${(result.duration / 1000).toFixed(1)}s)`);
    if (!result.passed && result.errors.length > 0) {
      console.log(`  FAST-FAIL: ${result.errors.length} errors in correctness gate`);
    }
  }

  // Act 2: User Flows
  if (!config.skipActs.includes(2)) {
    console.log("\n[Act 2] User Flows — 8 named smoke tests...");
    const result = await runAct2(ctx);
    acts.push(result);
    const badge = result.passed ? "PASS" : "FAIL";
    console.log(`  Act 2: ${badge} (${(result.duration / 1000).toFixed(1)}s)`);
  }

  // Act 3: Multi-day Simulation
  if (!config.skipActs.includes(3)) {
    console.log("\n[Act 3] Simulation — multi-day trading...");
    const result = await runAct3(ctx);
    acts.push(result);
    const badge = result.passed ? "PASS" : "FAIL";
    const durMin = Math.floor(result.duration / 60000);
    const durSec = Math.floor((result.duration % 60000) / 1000);
    console.log(`  Act 3: ${badge} (${durMin}m ${durSec}s)`);
  }

  const endMs = Date.now();

  // Build report
  const criteria = buildAcceptanceCriteria(acts, ctx);
  const allPass = criteria.every((c) => c.passed);

  const report: E2EReport = {
    runId: `${config.seed}-${startMs}`,
    config,
    startMs,
    endMs,
    verdict: allPass ? "PASS" : "FAIL",
    acts,
    days: [], // populated by act3 results
    agents: ctx.agents,
    metrics: ctx.metrics,
    errors: ctx.agents.flatMap((a) => a.errors),
    acceptanceCriteria: criteria,
  };

  // Extract day results from act3 if present
  const act3 = acts.find((a) => a.name === "Act 3: Simulation");
  if (act3) {
    report.errors.push(...act3.errors);
  }

  // Write report
  const htmlPath = await writeReport(report, config.outputDir);
  printConsoleSummary(report);

  console.log(`\nReport: ${htmlPath}`);

  // Auto-open report
  try {
    const { exec } = await import("child_process");
    exec(`open "${htmlPath}"`);
  } catch {
    // Non-macOS or no open command — ignore
  }

  process.exit(report.verdict === "PASS" ? 0 : 1);
}

// ── Acceptance Criteria ────────────────────────────────────────────────────

function buildAcceptanceCriteria(
  acts: ActResult[],
  ctx: { metrics: { instructionTypes: Set<string>; orderResults: { success: number; failed: number }; fillRate: number; latencies: number[] }; agents: { ordersPlaced: number }[] },
): AcceptanceCriterion[] {
  const instructionCount = ctx.metrics.instructionTypes.size;
  const totalOrders = ctx.metrics.orderResults.success + ctx.metrics.orderResults.failed;
  const successRate = totalOrders > 0 ? ctx.metrics.orderResults.success / totalOrders : 0;
  const fillRate = ctx.metrics.fillRate;
  const totalTxns = ctx.metrics.latencies.length;
  const p99 = totalTxns > 0
    ? ctx.metrics.latencies.sort((a, b) => a - b)[Math.floor(totalTxns * 0.99)] ?? 0
    : 0;
  const activeAgents = ctx.agents.filter((a) => a.ordersPlaced > 0).length;
  const agentParticipation = ctx.agents.length > 0 ? activeAgents / ctx.agents.length : 0;

  const act1 = acts.find((a) => a.name === "Act 1: Correctness");
  const act2 = acts.find((a) => a.name === "Act 2: User Flows");
  const act3 = acts.find((a) => a.name === "Act 3: Simulation");

  return [
    {
      id: "AC-01",
      description: ">= 18 instruction types exercised",
      passed: instructionCount >= 18,
      actual: `${instructionCount} types`,
    },
    {
      id: "AC-02",
      description: "Order success rate >= 80%",
      passed: successRate >= 0.8,
      actual: `${(successRate * 100).toFixed(1)}%`,
    },
    {
      id: "AC-03",
      description: "Zero verification violations",
      passed: act3 ? act3.errors.filter((e) => e.instruction === "verification").length === 0 : true,
      actual: act3 ? `${act3.errors.filter((e) => e.instruction === "verification").length} violations` : "N/A (skipped)",
    },
    {
      id: "AC-04",
      description: "Fill rate >= 20%",
      passed: fillRate >= 0.2,
      actual: `${(fillRate * 100).toFixed(1)}%`,
    },
    {
      id: "AC-05",
      description: "Act 1 passed (all instructions exercised)",
      passed: act1?.passed ?? false,
      actual: act1 ? (act1.passed ? "PASS" : "FAIL") : "SKIPPED",
    },
    {
      id: "AC-06",
      description: "Act 3 all markets settled and closed",
      passed: act3?.passed ?? false,
      actual: act3 ? (act3.passed ? "PASS" : "FAIL") : "SKIPPED",
    },
    {
      id: "AC-07",
      description: ">= 75% agent participation",
      passed: agentParticipation >= 0.75,
      actual: `${(agentParticipation * 100).toFixed(0)}% (${activeAgents}/${ctx.agents.length})`,
    },
    {
      id: "AC-08",
      description: "Total transactions > 100",
      passed: totalTxns > 100,
      actual: `${totalTxns} txns`,
    },
    {
      id: "AC-09",
      description: "P99 latency < 10,000ms",
      passed: p99 < 10_000,
      actual: `${p99}ms`,
    },
    {
      id: "AC-10",
      description: "All 8 Act 2 smoke tests passed",
      passed: act2?.passed ?? false,
      actual: act2 ? (act2.passed ? "8/8 PASS" : "FAIL") : "SKIPPED",
    },
  ];
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
