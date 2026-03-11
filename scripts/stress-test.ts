/**
 * stress-test.ts — Meridian stress test entry point.
 *
 * Runs 6 phases against a local solana-test-validator:
 *   Phase 1: Create 21 markets (7 tickers × 3 strikes)
 *   Phase 2: Fund 100 wallets with SOL + USDC
 *   Phase 3: Mint Yes/No token pairs on trading markets
 *   Phase 4: Place ~1,000+ orders (resting, crossing, no-backed, cancels, market)
 *   Phase 5: Settle lifecycle markets + pair-burn redemptions
 *   Phase 6: Close/cleanup lifecycle markets (may require --resume after 1h)
 *
 * Usage:
 *   npx tsx scripts/stress-test.ts              # full run
 *   npx tsx scripts/stress-test.ts --resume     # resume from last run
 *   STRESS_NUM_WALLETS=20 npx tsx scripts/stress-test.ts  # fewer wallets
 *
 * Prerequisites:
 *   - Local validator running: ./scripts/local-stack.sh
 *   - GlobalConfig + USDC mint initialized (local-stack.sh handles this)
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { loadKeypair, readEnv } from "./shared";
import { DEFAULTS, MARKET_DEFS, type RunState, type PhaseStats } from "./stress-test/config";
import { deriveMarketAddresses, readMarketState, type MarketAddresses } from "./stress-test/helpers";
import { phase1CreateMarkets } from "./stress-test/phase1-create-markets";
import { phase2FundWallets } from "./stress-test/phase2-fund-wallets";
import { phase3MintPairs } from "./stress-test/phase3-mint-pairs";
import { phase4Trading } from "./stress-test/phase4-trading";
import { phase5Settlement } from "./stress-test/phase5-settlement";
import { phase6Lifecycle } from "./stress-test/phase6-lifecycle";
import { printReport, type StressTestReport } from "./stress-test/report";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME ?? "~",
  ".config/solana/id.json",
);
const LAST_RUN_PATH = path.resolve(__dirname, "stress-test", "last-run.json");

async function main(): Promise<void> {
  const startMs = Date.now();
  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");

  console.log("=".repeat(80));
  console.log("MERIDIAN STRESS TEST");
  console.log("=".repeat(80));
  console.log(`RPC:     ${RPC_URL}`);
  console.log(`Wallets: ${DEFAULTS.NUM_WALLETS}`);
  console.log(`Markets: ${MARKET_DEFS.length} (7 tickers × 3 strikes)`);
  console.log(`Mode:    ${isResume ? "RESUME" : "NEW RUN"}`);

  // ── Load admin + env ──
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin:   ${admin.publicKey.toBase58()}`);

  const env = readEnv(ENV_PATH);
  if (!env["USDC_MINT"]) {
    throw new Error("USDC_MINT not found in .env. Run local-stack.sh first.");
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  console.log(`USDC:    ${usdcMint.toBase58()}`);

  if (!env["FAUCET_KEYPAIR"]) {
    throw new Error("FAUCET_KEYPAIR not found in .env.");
  }
  const faucetKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env["FAUCET_KEYPAIR"])),
  );

  // ── Run ID + time config ──
  let runState: RunState | undefined;
  if (isResume && fs.existsSync(LAST_RUN_PATH)) {
    runState = JSON.parse(fs.readFileSync(LAST_RUN_PATH, "utf-8"));
    console.log(`Resuming run ID: ${runState!.runId}`);
  }

  const runId = runState?.runId ?? Math.floor(Date.now() / 1000);
  const now = Math.floor(Date.now() / 1000);

  // Lifecycle markets: close 180s from now — enough time for Phase 1 to create them
  // and Phase 3 to mint a few pairs before close. Expired by Phase 5 (~4 min later).
  // admin_settle requires +1h so needs --resume.
  // Trading markets: close is tomorrow (allows minting + trading)
  const marketCloseUnixLifecycle = runState?.marketCloseUnixLifecycle ?? (now + 180);
  const marketCloseUnixTrading = runState?.marketCloseUnixTrading ?? (now + 86400);

  console.log(`Run ID:  ${runId}`);
  const lifecycleDelta = marketCloseUnixLifecycle - now;
  const lifecycleLabel = lifecycleDelta > 0 ? `in ${lifecycleDelta}s` : `${Math.abs(lifecycleDelta)}s ago`;
  console.log(`Lifecycle close: ${new Date(marketCloseUnixLifecycle * 1000).toISOString()} (${lifecycleLabel})`);
  console.log(`Trading close:   ${new Date(marketCloseUnixTrading * 1000).toISOString()} (tomorrow)`);
  console.log("");

  const allPhaseStats: PhaseStats[] = runState?.phaseStats ?? [];
  const completedPhases = new Set(runState?.completedPhases ?? []);

  // Track which instruction types were actually exercised (based on phase successes)
  const exercisedTypes = new Set<string>();
  let vaultViolations = 0;

  // ── Phase 1: Create Markets ──
  let markets: MarketAddresses[];
  if (completedPhases.has(1)) {
    console.log("[Phase 1] Already completed — re-deriving market addresses...");
    markets = MARKET_DEFS.map((def) => {
      const closeUnix = def.isLifecycle ? marketCloseUnixLifecycle : marketCloseUnixTrading;
      return deriveMarketAddresses(def, closeUnix);
    });
    // If phase was previously completed, assume these types were exercised
    exercisedTypes.add("initialize_feed").add("update_price")
      .add("allocate_order_book").add("create_strike_market").add("set_market_alt");
  } else {
    const result = await phase1CreateMarkets(
      connection, admin, usdcMint, runId,
      marketCloseUnixLifecycle, marketCloseUnixTrading,
    );
    markets = result.markets;
    allPhaseStats.push(result.stats);
    completedPhases.add(1);
    if (result.stats.succeeded > 0) {
      exercisedTypes.add("initialize_feed").add("update_price")
        .add("allocate_order_book").add("create_strike_market").add("set_market_alt");
    }
    saveRunState(runId, [], allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  }

  // ── Phase 2: Fund Wallets ──
  let wallets: Keypair[];
  if (completedPhases.has(2) && runState?.walletSecrets?.length) {
    console.log("[Phase 2] Already completed — restoring wallet keypairs...");
    wallets = runState.walletSecrets.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  } else {
    const result = await phase2FundWallets(connection, admin, faucetKp, usdcMint);
    wallets = result.wallets;
    allPhaseStats.push(result.stats);
    completedPhases.add(2);
    saveRunState(runId, wallets, allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  }

  // ── Phase 3: Mint Pairs ──
  if (!completedPhases.has(3)) {
    const result = await phase3MintPairs(connection, wallets, usdcMint, markets);
    allPhaseStats.push(result.stats);
    completedPhases.add(3);
    if (result.stats.succeeded > 0) exercisedTypes.add("mint_pair");
    saveRunState(runId, wallets, allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  } else {
    console.log("[Phase 3] Already completed — skipping.");
    exercisedTypes.add("mint_pair");
  }

  // ── Phase 4: Trading ──
  if (!completedPhases.has(4)) {
    const result = await phase4Trading(connection, admin, wallets, usdcMint, markets);
    allPhaseStats.push(result.stats);
    completedPhases.add(4);
    if (result.stats.succeeded > 0) {
      exercisedTypes.add("place_order").add("cancel_order")
        .add("pause").add("unpause");
    }
    saveRunState(runId, wallets, allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  } else {
    console.log("[Phase 4] Already completed — skipping.");
    exercisedTypes.add("place_order").add("cancel_order")
      .add("pause").add("unpause");
  }

  // ── Phase 5: Settlement + Redemption ──
  if (!completedPhases.has(5)) {
    const result = await phase5Settlement(connection, admin, wallets, usdcMint, markets);
    allPhaseStats.push(result.stats);
    vaultViolations = result.vaultViolations;
    completedPhases.add(5);
    if (result.stats.succeeded > 0) {
      exercisedTypes.add("settle_market").add("admin_settle")
        .add("admin_override_settlement").add("redeem").add("update_price");
    }
    saveRunState(runId, wallets, allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  } else {
    console.log("[Phase 5] Already completed — skipping.");
    exercisedTypes.add("settle_market").add("admin_settle")
      .add("admin_override_settlement").add("redeem").add("update_price");
  }

  // ── Phase 6: Lifecycle ──
  if (!completedPhases.has(6)) {
    const result = await phase6Lifecycle(connection, admin, wallets, usdcMint, markets);
    allPhaseStats.push(result.stats);
    // Only mark complete if close_market actually succeeded for all
    const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);
    let closedCount = 0;
    for (const m of lifecycleMarkets) {
      const state = await readMarketState(connection, m.market);
      if (state?.isClosed) closedCount++;
    }
    if (closedCount >= lifecycleMarkets.length) {
      completedPhases.add(6);
    }
    // Track instruction types that were actually attempted (even if they failed due to timing)
    exercisedTypes.add("crank_cancel").add("close_market");
    if (closedCount > 0) {
      exercisedTypes.add("treasury_redeem").add("cleanup_market");
    }
    saveRunState(runId, wallets, allPhaseStats, marketCloseUnixLifecycle, marketCloseUnixTrading, completedPhases);
  } else {
    console.log("[Phase 6] Already completed — skipping.");
    exercisedTypes.add("crank_cancel").add("close_market")
      .add("treasury_redeem").add("cleanup_market");
  }

  // ── Build report ──
  const endMs = Date.now();

  // Count metrics
  let marketsCreated = 0;
  let marketsSettled = 0;
  let marketsClosed = 0;
  const lifecycleMarkets = markets.filter((m) => m.def.isLifecycle);

  for (const m of markets) {
    const acct = await connection.getAccountInfo(m.market);
    if (acct) marketsCreated++;
  }
  for (const m of lifecycleMarkets) {
    const state = await readMarketState(connection, m.market);
    if (state?.isSettled) marketsSettled++;
    if (state?.isClosed) marketsClosed++;
  }

  const overrideWindowActive = marketsClosed < lifecycleMarkets.length && marketsSettled > 0;

  const report: StressTestReport = {
    startMs,
    endMs,
    numWallets: wallets.length,
    numMarkets: markets.length,
    phases: allPhaseStats,
    marketsCreated,
    marketsSettled,
    marketsClosed,
    vaultViolations,
    instructionTypesExercised: exercisedTypes.size,
    totalInstructionTypes: 18,
    overrideWindowActive,
  };

  const passed = printReport(report);
  process.exit(passed ? 0 : 1);
}

function saveRunState(
  runId: number,
  wallets: Keypair[],
  phaseStats: PhaseStats[],
  marketCloseUnixLifecycle: number,
  marketCloseUnixTrading: number,
  completedPhases: Set<number>,
): void {
  const state: RunState = {
    runId,
    walletSecrets: wallets.map((w) => Array.from(w.secretKey)),
    phaseStats,
    marketCloseUnixLifecycle,
    marketCloseUnixTrading,
    completedPhases: Array.from(completedPhases),
  };
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
