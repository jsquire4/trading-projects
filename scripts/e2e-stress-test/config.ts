/**
 * config.ts — RunConfig defaults, CLI arg parsing, and shared constants.
 */

import type { RunConfig } from "./types";

// ── Default configuration ──────────────────────────────────────────────────

export const DEFAULT_CONFIG: RunConfig = {
  seed: 42,
  numAgents: 20,
  numDays: 2,
  marketCloseOffsetSec: 240,
  tradingWindowSec: 180,
  concurrency: 10,
  tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8899",
  outputDir: "./stress-reports",
  skipActs: [],
};

// ── Constants ──────────────────────────────────────────────────────────────

export const ORDER_BOOK_TOTAL_SPACE = 8 + 254_280;
export const MAX_GROWTH = 10_240;
export const ALLOC_BATCH_SIZE = 6;
export const ALLOC_CALLS_REQUIRED = Math.ceil(254_280 / MAX_GROWTH);
export const STRESS_ADMIN_SETTLE_DELAY_S = 5;
export const STRESS_OVERRIDE_WINDOW_S = 5;
export const STRESS_GRACE_PERIOD_S = 5;
export const USDC_DECIMALS = 6;
export const MIN_MINT_QUANTITY = 1_000_000n;
export const DEFAULT_MINT_QUANTITY = 50_000_000n;
export const MAX_FILLS = 5;
export const CRANK_CANCEL_BATCH_SIZE = 32;
export const CRANK_REDEEM_MAX_USERS = 16;
export const ALT_WARMUP_SLEEP_MS = 500;
export const CONFIDENCE_BPS_OF_PRICE = 40;
export const SOL_PER_AGENT = 5;
export const USDC_PER_AGENT = 1_000_000_000; // $1000 in USDC lamports

// ── CLI arg parsing ────────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): Partial<RunConfig> {
  const overrides: Partial<RunConfig> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--seed":
        overrides.seed = parseInt(next, 10);
        i++;
        break;
      case "--agents":
        overrides.numAgents = parseInt(next, 10);
        i++;
        break;
      case "--days":
        overrides.numDays = parseInt(next, 10);
        i++;
        break;
      case "--close-offset":
        overrides.marketCloseOffsetSec = parseInt(next, 10);
        i++;
        break;
      case "--trading-window":
        overrides.tradingWindowSec = parseInt(next, 10);
        i++;
        break;
      case "--concurrency":
        overrides.concurrency = parseInt(next, 10);
        i++;
        break;
      case "--tickers":
        overrides.tickers = next.split(",").map((t) => t.trim());
        i++;
        break;
      case "--rpc":
        overrides.rpcUrl = next;
        i++;
        break;
      case "--output":
        overrides.outputDir = next;
        i++;
        break;
      case "--skip-acts":
        overrides.skipActs = next.split(",").map((n) => parseInt(n.trim(), 10));
        i++;
        break;
    }
  }

  return overrides;
}

export function buildConfig(overrides: Partial<RunConfig>): RunConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
