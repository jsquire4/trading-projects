/**
 * report-template.ts — Self-contained HTML report with inline CSS and Chart.js.
 *
 * Returns a complete HTML string that can be opened in any browser.
 * All data is embedded inline; no external dependencies except Chart.js CDN.
 */

import type {
  E2EReport,
  AcceptanceCriterion,
  ActResult,
  AgentState,
  ErrorEntry,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert bigint-containing objects to JSON-safe form. */
function safe(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = safe(v);
    }
    return out;
  }
  return value;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(passed: boolean): string {
  return passed
    ? `<span class="badge pass">PASS</span>`
    : `<span class="badge fail">FAIL</span>`;
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return min > 0 ? `${min}m ${rem}s` : `${rem}s`;
}

// ─── Known instruction names for coverage checklist ───────────────────────────

const KNOWN_INSTRUCTIONS = [
  // Setup
  "initialize_config",
  "initialize_feed",
  // Market lifecycle
  "allocate_order_book",
  "create_strike_market",
  "set_market_alt",
  // Trading
  "mint_pair",
  "place_order",
  "cancel_order",
  "update_price",
  // Admin
  "pause",
  "unpause",
  "update_fee_bps",
  "update_strike_creation_fee",
  // Settlement
  "settle_market",
  "admin_settle",
  "admin_override_settlement",
  // Redemption
  "redeem",
  "crank_cancel",
  "crank_redeem",
  // Cleanup
  "close_market",
  "treasury_redeem",
  "cleanup_market",
];

// ─── Main render ──────────────────────────────────────────────────────────────

export function renderHtmlReport(report: E2EReport): string {
  const totalDuration = report.endMs - report.startMs;
  const verdictColor = report.verdict === "PASS" ? "#0f9b58" : "#ea4335";
  const instructionSet = report.metrics.instructionTypes;

  // Prepare chart data
  const tpsData = JSON.stringify(safe(report.metrics.tpsTimeline));
  const latencies = report.metrics.latencies;
  const latencyBins = buildLatencyBins(latencies);
  const latencyBinData = JSON.stringify(latencyBins);

  const orderSuccess = report.metrics.orderResults.success;
  const orderFailed = report.metrics.orderResults.failed;

  // Top 20 agents by ordersPlaced
  const topAgents = [...report.agents]
    .sort((a, b) => b.ordersPlaced - a.ordersPlaced)
    .slice(0, 20);

  // Last 50 errors
  const recentErrors = report.errors.slice(-50);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>E2E Stress Test — ${esc(report.runId)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif; padding: 24px; }
  h1, h2, h3 { color: #fff; }
  h1 { font-size: 1.6rem; margin-bottom: 8px; }
  h2 { font-size: 1.2rem; margin: 24px 0 12px; border-bottom: 1px solid #2a2a4e; padding-bottom: 6px; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .verdict { display: inline-block; padding: 6px 18px; border-radius: 6px; font-weight: 700; font-size: 1.4rem; color: #fff; background: ${verdictColor}; }
  .card { background: #16213e; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .config-grid dt { color: #8899aa; font-size: 0.85rem; }
  .config-grid dd { font-weight: 600; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #2a2a4e; }
  th { color: #8899aa; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 700; }
  .badge.pass { background: #0f9b58; color: #fff; }
  .badge.fail { background: #ea4335; color: #fff; }
  .check { color: #0f9b58; } .cross { color: #ea4335; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .chart-box { background: #16213e; border-radius: 8px; padding: 12px; }
  canvas { max-height: 260px; }
  .mono { font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.85rem; }
  @media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <h1>E2E Stress Test</h1>
  <div class="verdict">${esc(report.verdict)}</div>
</div>
<div class="card">
  <dl class="config-grid">
    <div><dt>Run ID</dt><dd class="mono">${esc(report.runId)}</dd></div>
    <div><dt>Seed</dt><dd>${report.config.seed}</dd></div>
    <div><dt>Agents</dt><dd>${report.config.numAgents}</dd></div>
    <div><dt>Days</dt><dd>${report.config.numDays}</dd></div>
    <div><dt>Tickers</dt><dd>${report.config.tickers.length}</dd></div>
    <div><dt>Duration</dt><dd>${fmtDuration(totalDuration)}</dd></div>
  </dl>
</div>

<!-- Section 1: Acts Summary -->
<h2>Acts Summary</h2>
<div class="card">
<table>
  <thead><tr><th>Act</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead>
  <tbody>
${report.acts.map((act, i) => `    <tr>
      <td>Act ${i + 1}: ${esc(act.name)}</td>
      <td>${badge(act.passed)}</td>
      <td>${fmtDuration(act.duration)}</td>
      <td>${act.details.map((d) => esc(d)).join("<br>")}</td>
    </tr>`).join("\n")}
  </tbody>
</table>
</div>

<!-- Section 2: Day Results -->
<h2>Day Results</h2>
<div class="card">
<table>
  <thead><tr>
    <th>Day</th><th>Created</th><th>Settled</th><th>Closed</th>
    <th>Orders</th><th>Filled</th><th>Vault Violations</th>
  </tr></thead>
  <tbody>
${report.days.map((d) => `    <tr>
      <td>${d.day}</td>
      <td>${d.marketsCreated}</td>
      <td>${d.marketsSettled}</td>
      <td>${d.marketsClosed}</td>
      <td>${d.ordersPlaced}</td>
      <td>${d.ordersFilled}</td>
      <td>${d.vaultViolations > 0 ? `<span class="cross">${d.vaultViolations}</span>` : "0"}</td>
    </tr>`).join("\n")}
  </tbody>
</table>
</div>

<!-- Section 3: Metrics -->
<h2>Metrics</h2>
<div class="charts">
  <div class="chart-box"><canvas id="tpsChart"></canvas></div>
  <div class="chart-box"><canvas id="latencyChart"></canvas></div>
  <div class="chart-box"><canvas id="orderPie"></canvas></div>
</div>

<!-- Section 4: Instruction Coverage -->
<h2>Instruction Coverage</h2>
<div class="card">
<table>
  <thead><tr><th>Instruction</th><th>Exercised</th></tr></thead>
  <tbody>
${KNOWN_INSTRUCTIONS.map((name) => {
    const hit = instructionSet.has(name);
    return `    <tr>
      <td class="mono">${esc(name)}</td>
      <td>${hit ? '<span class="check">&#10003;</span>' : '<span class="cross">&#10007;</span>'}</td>
    </tr>`;
  }).join("\n")}
  </tbody>
</table>
</div>

<!-- Section 5: Acceptance Criteria -->
<h2>Acceptance Criteria</h2>
<div class="card">
<table>
  <thead><tr><th>ID</th><th>Description</th><th>Actual</th><th>Status</th></tr></thead>
  <tbody>
${report.acceptanceCriteria.map((ac) => `    <tr>
      <td class="mono">${esc(ac.id)}</td>
      <td>${esc(ac.description)}</td>
      <td>${esc(ac.actual)}</td>
      <td>${badge(ac.passed)}</td>
    </tr>`).join("\n")}
  </tbody>
</table>
</div>

<!-- Section 6: Agent Ledger -->
<h2>Agent Ledger (Top 20)</h2>
<div class="card">
<table>
  <thead><tr>
    <th>ID</th><th>Type</th><th>Orders</th><th>Filled</th>
    <th>Positions</th><th>Errors</th>
  </tr></thead>
  <tbody>
${topAgents.map((a) => `    <tr>
      <td>${a.id}</td>
      <td>${esc(a.type)}</td>
      <td>${a.ordersPlaced}</td>
      <td>${a.ordersFilled}</td>
      <td>${a.positionsOpened}</td>
      <td>${a.errors.length > 0 ? `<span class="cross">${a.errors.length}</span>` : "0"}</td>
    </tr>`).join("\n")}
  </tbody>
</table>
</div>

<!-- Section 7: Error Log -->
<h2>Error Log (Last 50)</h2>
<div class="card">
<table>
  <thead><tr><th>Time</th><th>Agent</th><th>Instruction</th><th>Message</th></tr></thead>
  <tbody>
${recentErrors.map((e) => `    <tr>
      <td class="mono">${new Date(e.timestamp).toISOString().slice(11, 19)}</td>
      <td>${e.agentId}</td>
      <td class="mono">${esc(e.instruction)}</td>
      <td>${esc(e.message.slice(0, 120))}</td>
    </tr>`).join("\n")}
  </tbody>
</table>
</div>

<script>
(function() {
  const tpsData = ${tpsData};
  const latencyBins = ${latencyBinData};
  const orderSuccess = ${orderSuccess};
  const orderFailed = ${orderFailed};

  // TPS Timeline
  new Chart(document.getElementById('tpsChart'), {
    type: 'line',
    data: {
      labels: tpsData.map((p, i) => i),
      datasets: [{
        label: 'TPS',
        data: tpsData.map(p => p.tps),
        borderColor: '#4285f4',
        backgroundColor: 'rgba(66,133,244,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'TPS Timeline', color: '#fff' } },
      scales: {
        x: { display: false },
        y: { ticks: { color: '#8899aa' }, grid: { color: '#2a2a4e' } }
      }
    }
  });

  // Latency Histogram
  new Chart(document.getElementById('latencyChart'), {
    type: 'bar',
    data: {
      labels: latencyBins.map(b => b.label),
      datasets: [{
        label: 'Count',
        data: latencyBins.map(b => b.count),
        backgroundColor: '#4285f4',
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Latency Distribution (ms)', color: '#fff' } },
      scales: {
        x: { ticks: { color: '#8899aa' }, grid: { color: '#2a2a4e' } },
        y: { ticks: { color: '#8899aa' }, grid: { color: '#2a2a4e' } }
      }
    }
  });

  // Order Pie
  new Chart(document.getElementById('orderPie'), {
    type: 'doughnut',
    data: {
      labels: ['Success', 'Failed'],
      datasets: [{
        data: [orderSuccess, orderFailed],
        backgroundColor: ['#0f9b58', '#ea4335'],
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Order Results', color: '#fff' } }
    }
  });
})();
</script>

</body>
</html>`;
}

// ─── Latency binning ──────────────────────────────────────────────────────────

interface LatencyBin {
  label: string;
  count: number;
}

function buildLatencyBins(latencies: number[]): LatencyBin[] {
  if (latencies.length === 0) {
    return [{ label: "0", count: 0 }];
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  const binCount = 10;
  const binSize = Math.max(1, Math.ceil(max / binCount));

  const bins: LatencyBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i * binSize;
    const hi = lo + binSize;
    const count = sorted.filter((v) => v >= lo && v < hi).length;
    bins.push({ label: `${lo}-${hi}`, count });
  }

  return bins;
}
