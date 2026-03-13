/**
 * setup.ts — Validator check, oracle feed init, wallet funding, SharedContext assembly.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
// Manual .env loading (no dotenv dependency)
function loadEnv(envPath: string): void {
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file not found — rely on existing env vars
  }
}

import type { RunConfig, SharedContext, AgentState, Metrics } from "./types";
import { SOL_PER_AGENT, USDC_PER_AGENT } from "./config";

import { fundWallet, batch } from "../stress-test/helpers";
import {
  findGlobalConfig,
  findFeeVault,
  findTreasury,
  findPriceFeed,
} from "../../services/shared/src/pda";
import { buildInitializeFeedIx } from "../../tests/helpers/instructions";
import { sendTx } from "../stress-test/helpers";
import { SeededRng, hashSeed } from "../../services/shared/src/synthetic-config";

// ── Setup ──────────────────────────────────────────────────────────────────

export async function setupTestEnvironment(config: RunConfig): Promise<SharedContext> {
  // Load .env from project root
  loadEnv(path.resolve(__dirname, "../../.env"));

  // 1. Read admin keypair
  const adminPath = process.env.ADMIN_KEYPAIR ??
    path.resolve(process.env.HOME!, ".config/solana/id.json");
  const adminSecret = JSON.parse(fs.readFileSync(adminPath, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));

  // 2. Read USDC mint and faucet keypair
  const usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) throw new Error("USDC_MINT not set in .env");
  const usdcMint = new PublicKey(usdcMintStr);

  const faucetJson = process.env.FAUCET_KEYPAIR;
  if (!faucetJson) throw new Error("FAUCET_KEYPAIR not set in .env");
  const faucetSecret = JSON.parse(faucetJson);
  const faucet = Keypair.fromSecretKey(Uint8Array.from(faucetSecret));

  // 3. Connect and verify
  const connection = new Connection(config.rpcUrl, "confirmed");
  const balance = await connection.getBalance(admin.publicKey);
  console.log(`  Admin: ${admin.publicKey.toBase58()} (${balance / LAMPORTS_PER_SOL} SOL)`);
  if (balance < 10 * LAMPORTS_PER_SOL) {
    console.log("  Airdropping SOL to admin...");
    const sig = await connection.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // 4. Verify GlobalConfig PDA exists
  const [configPda] = findGlobalConfig();
  const configAcct = await connection.getAccountInfo(configPda);
  if (!configAcct) {
    throw new Error(
      `GlobalConfig PDA not found at ${configPda.toBase58()}. ` +
      "Run initialize_config first (e.g. via anchor test or the stress test setup)."
    );
  }

  const [feeVault] = findFeeVault();
  const [treasury] = findTreasury();

  // 5. Initialize oracle feeds for each ticker (idempotent)
  for (const ticker of config.tickers) {
    const [oracleFeed] = findPriceFeed(ticker);
    const feedAcct = await connection.getAccountInfo(oracleFeed);
    if (!feedAcct) {
      console.log(`  Initializing oracle feed for ${ticker}...`);
      const ix = buildInitializeFeedIx({
        authority: admin.publicKey,
        priceFeed: oracleFeed,
        ticker,
      });
      const tx = new Transaction().add(ix);
      await sendTx(connection, tx, [admin]);
    }
  }

  // 6. Generate agent keypairs (seeded for determinism)
  const agentKeypairs: Keypair[] = [];
  for (let i = 0; i < config.numAgents; i++) {
    const agentRng = new SeededRng(hashSeed(config.seed, `keypair-${i}`));
    const secretBytes = new Uint8Array(32);
    for (let j = 0; j < 32; j++) {
      secretBytes[j] = Math.floor(agentRng.next() * 256);
    }
    agentKeypairs.push(Keypair.fromSeed(secretBytes));
  }

  // 7. Fund agents in batches
  console.log(`  Funding ${config.numAgents} agents...`);
  const batches = batch(agentKeypairs, 10);
  for (const group of batches) {
    await Promise.all(
      group.map((kp) =>
        fundWallet(connection, admin, faucet, usdcMint, kp, SOL_PER_AGENT, USDC_PER_AGENT)
      ),
    );
  }

  // 8. Initialize AgentState for each
  const agentTypes = distributeAgentTypes(config.numAgents);
  const agents: AgentState[] = agentKeypairs.map((kp, i) => ({
    id: i,
    type: agentTypes[i],
    keypair: kp,
    rng: new SeededRng(hashSeed(config.seed, `agent-${i}`)),
    startingUsdc: BigInt(USDC_PER_AGENT),
    currentUsdc: BigInt(USDC_PER_AGENT),
    ordersPlaced: 0,
    ordersFilled: 0,
    positionsOpened: 0,
    positionsClosed: 0,
    errors: [],
  }));

  // 9. Initialize empty Metrics
  const metrics: Metrics = {
    tpsTimeline: [],
    latencies: [],
    orderResults: {
      success: 0,
      failed: 0,
      errors: new Map(),
    },
    fillRate: 0,
    mergeCount: 0,
    instructionTypes: new Set(),
  };

  // 10. Assemble SharedContext
  return {
    connection,
    admin,
    faucet,
    usdcMint,
    configPda,
    feeVault,
    treasury,
    markets: [],
    agents,
    config,
    metrics,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Distribute agent types according to rough ratios:
 * ~20% market-maker, ~40% directional, ~25% scalper, ~15% strike-creator
 */
function distributeAgentTypes(numAgents: number): AgentState["type"][] {
  const types: AgentState["type"][] = [];
  const mmCount = Math.max(2, Math.round(numAgents * 0.2));
  const dirCount = Math.max(2, Math.round(numAgents * 0.4));
  const scalpCount = Math.max(2, Math.round(numAgents * 0.25));
  const strikeCount = Math.max(1, numAgents - mmCount - dirCount - scalpCount);

  for (let i = 0; i < mmCount; i++) types.push("market-maker");
  for (let i = 0; i < dirCount; i++) types.push("directional");
  for (let i = 0; i < scalpCount; i++) types.push("scalper");
  for (let i = 0; i < strikeCount; i++) types.push("strike-creator");

  // Trim or pad to exact numAgents
  while (types.length > numAgents) types.pop();
  while (types.length < numAgents) types.push("directional");

  return types;
}
