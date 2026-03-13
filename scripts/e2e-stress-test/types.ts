/**
 * types.ts — All shared interfaces and types for the E2E Stress Test.
 * Pure interface definitions. No logic.
 */

import type { Keypair, Connection, PublicKey } from "@solana/web3.js";
import type { SeededRng } from "../../services/shared/src/synthetic-config";

// ── RunConfig ──────────────────────────────────────────────────────────────

export interface RunConfig {
  seed: number;
  numAgents: number;
  numDays: number;
  marketCloseOffsetSec: number;
  tradingWindowSec: number;
  concurrency: number;
  tickers: string[];
  rpcUrl: string;
  outputDir: string;
  skipActs: number[];
}

// ── AgentState ─────────────────────────────────────────────────────────────

export type AgentType = "market-maker" | "directional" | "scalper" | "strike-creator";

export interface ErrorEntry {
  timestamp: number;
  agentId: number;
  instruction: string;
  market?: string;
  message: string;
}

export interface AgentState {
  id: number;
  type: AgentType;
  keypair: Keypair;
  rng: SeededRng;
  startingUsdc: bigint;
  currentUsdc: bigint;
  ordersPlaced: number;
  ordersFilled: number;
  positionsOpened: number;
  positionsClosed: number;
  errors: ErrorEntry[];
}

// ── MarketContext ───────────────────────────────────────────────────────────

export interface MarketContext {
  ticker: string;
  strikeLamports: bigint;
  previousCloseLamports: bigint;
  marketCloseUnix: number;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
  altAddress?: PublicKey;
  day: number;
}

// ── DayResult ──────────────────────────────────────────────────────────────

export interface DayResult {
  day: number;
  marketsCreated: number;
  marketsSettled: number;
  marketsClosed: number;
  tokensMinted: bigint;
  tokensRedeemed: bigint;
  ordersPlaced: number;
  ordersFilled: number;
  mergeCount: number;
  escrowReturned: bigint;
  vaultViolations: number;
  settlementOutcomes: Map<string, "yes" | "no">;
}

// ── Metrics ────────────────────────────────────────────────────────────────

export interface TpsPoint {
  timestamp: number;
  tps: number;
}

export interface Metrics {
  tpsTimeline: TpsPoint[];
  latencies: number[];
  orderResults: {
    success: number;
    failed: number;
    errors: Map<string, number>;
  };
  fillRate: number;
  mergeCount: number;
  instructionTypes: Set<string>;
}

// ── ActResult ──────────────────────────────────────────────────────────────

export interface ActResult {
  name: string;
  passed: boolean;
  duration: number;
  details: string[];
  errors: ErrorEntry[];
}

// ── AcceptanceCriterion ────────────────────────────────────────────────────

export interface AcceptanceCriterion {
  id: string;
  description: string;
  passed: boolean;
  actual: string;
}

// ── E2EReport ──────────────────────────────────────────────────────────────

export interface E2EReport {
  runId: string;
  config: RunConfig;
  startMs: number;
  endMs: number;
  verdict: "PASS" | "FAIL";
  acts: ActResult[];
  days: DayResult[];
  agents: AgentState[];
  metrics: Metrics;
  errors: ErrorEntry[];
  acceptanceCriteria: AcceptanceCriterion[];
}

// ── SharedContext ───────────────────────────────────────────────────────────

export interface SharedContext {
  connection: Connection;
  admin: Keypair;
  faucet: Keypair;
  usdcMint: PublicKey;
  configPda: PublicKey;
  feeVault: PublicKey;
  treasury: PublicKey;
  markets: MarketContext[];
  agents: AgentState[];
  config: RunConfig;
  metrics: Metrics;
}

// ── VerificationResult ─────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
}
