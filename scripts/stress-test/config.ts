/**
 * config.ts — Market definitions, wallet counts, and tunable parameters
 * for the Meridian stress test.
 */

// ---------------------------------------------------------------------------
// Defaults (overridable via env vars)
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  NUM_WALLETS: parseInt(process.env.STRESS_NUM_WALLETS ?? "100", 10),
  USDC_PER_WALLET: 1_000_000_000,        // $1000 in USDC lamports
  PAIRS_PER_MARKET: 10_000_000,           // 10 tokens per wallet per market
  MARKET_CREATION_BATCH_SIZE: 5,
  SOL_PER_WALLET: 5,
  ORDER_QUANTITY: 1_000_000,              // 1 token per order
};

// ---------------------------------------------------------------------------
// Tickers
// ---------------------------------------------------------------------------

export const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Ticker = (typeof TICKERS)[number];

// ---------------------------------------------------------------------------
// Market definitions
// ---------------------------------------------------------------------------

export interface MarketDef {
  ticker: Ticker;
  /** Strike price in USDC lamports (6 decimals) */
  strikeLamports: bigint;
  /** Previous close in USDC lamports */
  previousCloseLamports: bigint;
  /** If true, this market has close time in the past (for settlement/close demo) */
  isLifecycle: boolean;
}

/**
 * 21 markets: 7 tickers × 3 strikes each.
 * Strike 1 per ticker = lifecycle (close in ~3 min), Strikes 2-3 = trading (close tomorrow).
 */
export const MARKET_DEFS: MarketDef[] = [
  // AAPL
  { ticker: "AAPL", strikeLamports: 220_000_000n, previousCloseLamports: 218_000_000n, isLifecycle: true },
  { ticker: "AAPL", strikeLamports: 230_000_000n, previousCloseLamports: 228_000_000n, isLifecycle: false },
  { ticker: "AAPL", strikeLamports: 240_000_000n, previousCloseLamports: 238_000_000n, isLifecycle: false },
  // MSFT
  { ticker: "MSFT", strikeLamports: 415_000_000n, previousCloseLamports: 412_000_000n, isLifecycle: true },
  { ticker: "MSFT", strikeLamports: 425_000_000n, previousCloseLamports: 422_000_000n, isLifecycle: false },
  { ticker: "MSFT", strikeLamports: 435_000_000n, previousCloseLamports: 432_000_000n, isLifecycle: false },
  // GOOGL
  { ticker: "GOOGL", strikeLamports: 185_000_000n, previousCloseLamports: 183_000_000n, isLifecycle: true },
  { ticker: "GOOGL", strikeLamports: 195_000_000n, previousCloseLamports: 193_000_000n, isLifecycle: false },
  { ticker: "GOOGL", strikeLamports: 205_000_000n, previousCloseLamports: 203_000_000n, isLifecycle: false },
  // AMZN
  { ticker: "AMZN", strikeLamports: 200_000_000n, previousCloseLamports: 198_000_000n, isLifecycle: true },
  { ticker: "AMZN", strikeLamports: 210_000_000n, previousCloseLamports: 208_000_000n, isLifecycle: false },
  { ticker: "AMZN", strikeLamports: 220_000_000n, previousCloseLamports: 218_000_000n, isLifecycle: false },
  // NVDA
  { ticker: "NVDA", strikeLamports: 135_000_000n, previousCloseLamports: 133_000_000n, isLifecycle: true },
  { ticker: "NVDA", strikeLamports: 145_000_000n, previousCloseLamports: 143_000_000n, isLifecycle: false },
  { ticker: "NVDA", strikeLamports: 155_000_000n, previousCloseLamports: 153_000_000n, isLifecycle: false },
  // META
  { ticker: "META", strikeLamports: 690_000_000n, previousCloseLamports: 685_000_000n, isLifecycle: true },
  { ticker: "META", strikeLamports: 710_000_000n, previousCloseLamports: 705_000_000n, isLifecycle: false },
  { ticker: "META", strikeLamports: 730_000_000n, previousCloseLamports: 725_000_000n, isLifecycle: false },
  // TSLA
  { ticker: "TSLA", strikeLamports: 325_000_000n, previousCloseLamports: 320_000_000n, isLifecycle: true },
  { ticker: "TSLA", strikeLamports: 345_000_000n, previousCloseLamports: 340_000_000n, isLifecycle: false },
  { ticker: "TSLA", strikeLamports: 365_000_000n, previousCloseLamports: 360_000_000n, isLifecycle: false },
];

/**
 * Settlement prices for lifecycle markets. If price >= strike → Yes wins (1),
 * else No wins (2). Mix of outcomes across tickers.
 */
export const SETTLEMENT_PRICES: Record<Ticker, bigint> = {
  AAPL:  225_000_000n,   // > 220 → Yes wins
  MSFT:  410_000_000n,   // < 415 → No wins
  GOOGL: 190_000_000n,   // > 185 → Yes wins
  AMZN:  195_000_000n,   // < 200 → No wins
  NVDA:  140_000_000n,   // > 135 → Yes wins
  META:  680_000_000n,   // < 690 → No wins
  TSLA:  330_000_000n,   // > 325 → Yes wins
};

// ---------------------------------------------------------------------------
// Phase stats tracking
// ---------------------------------------------------------------------------

export interface PhaseStats {
  name: string;
  attempted: number;
  succeeded: number;
  failed: number;
  startMs: number;
  endMs: number;
  errors: string[];
}

export function newPhaseStats(name: string): PhaseStats {
  return {
    name,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    startMs: Date.now(),
    endMs: 0,
    errors: [],
  };
}

export function finishPhaseStats(stats: PhaseStats): PhaseStats {
  stats.endMs = Date.now();
  return stats;
}

// ---------------------------------------------------------------------------
// Run state (for --resume)
// ---------------------------------------------------------------------------

export interface RunState {
  runId: number;
  walletSecrets: number[][];
  phaseStats: PhaseStats[];
  marketCloseUnixLifecycle: number;
  marketCloseUnixTrading: number;
  completedPhases: number[];
}
