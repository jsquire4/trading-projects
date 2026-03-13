#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Market Initializer — entry point
//
// Live mode: one-shot job (fetch prices, calculate strikes, create markets).
// Synthetic mode: starts an HTTP trigger server for on-demand market creation.
//
// Designed to run at 8:00 AM ET via scheduler, or manually:
//   npx tsx src/index.ts
// ---------------------------------------------------------------------------

import http from "node:http";
import { createLogger } from "../../shared/src/alerting.ts";
import { initializeMarkets } from "./initializer.ts";

const log = createLogger("market-initializer");

// ---------------------------------------------------------------------------
// Shared: run one initialization cycle and log results
// ---------------------------------------------------------------------------

async function runCycle(): Promise<{ ok: boolean; error?: string; summary?: Record<string, unknown> }> {
  const results = await initializeMarkets();

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

  const summary = { tickers: results.length, totalCreated, totalSkipped, totalErrors };
  log.info("Market Initializer cycle complete", summary);

  if (totalErrors > 0) {
    const allErrors = results.flatMap((r) => r.errors);
    return { ok: false, error: `${totalErrors} error(s)`, summary: { ...summary, errors: allErrors } };
  }

  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// Synthetic mode: HTTP trigger server
// ---------------------------------------------------------------------------

function startTriggerServer(): void {
  const port = parseInt(process.env.TRIGGER_PORT ?? "4001", 10);
  let running = false;

  const server = http.createServer(async (req, res) => {
    // Only handle /trigger
    if (req.url !== "/trigger") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed — use POST" }));
      return;
    }

    // Concurrency lock
    if (running) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Initialization cycle already in progress" }));
      return;
    }

    running = true;
    try {
      const result = await runCycle();
      const status = result.ok ? 200 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Trigger cycle failed", { error: msg });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    } finally {
      running = false;
    }
  });

  server.listen(port, () => {
    log.info(`Trigger server listening on port ${port} (POST /trigger)`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isSynthetic = process.env.MARKET_DATA_SOURCE === "synthetic";

  if (isSynthetic) {
    log.info("Market Initializer starting in SYNTHETIC mode — trigger server");
    startTriggerServer();
    return; // Keep process alive (HTTP server)
  }

  // Live mode: one-shot
  log.info("Market Initializer starting (live mode)");
  const result = await runCycle();

  if (!result.ok) {
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
