/**
 * base-agent.ts — Abstract base class for all stress test agent types.
 * Provides shared wallet helpers, timed transaction sending, and error recording.
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { SharedContext, AgentState, AgentType, ErrorEntry, MarketContext } from "../types";
import { sendTx } from "../../stress-test/helpers";

// ---------------------------------------------------------------------------
// BaseAgent
// ---------------------------------------------------------------------------

export abstract class BaseAgent {
  readonly id: number;
  readonly type: AgentType;
  readonly keypair: Keypair;
  state: AgentState;

  constructor(state: AgentState, protected ctx: SharedContext) {
    this.id = state.id;
    this.type = state.type;
    this.keypair = state.keypair;
    this.state = state;
  }

  // ── ATA helpers ──────────────────────────────────────────────────────────

  protected usdcAta(): PublicKey {
    return getAssociatedTokenAddressSync(this.ctx.usdcMint, this.keypair.publicKey);
  }

  protected yesAta(yesMint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(yesMint, this.keypair.publicKey);
  }

  protected noAta(noMint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(noMint, this.keypair.publicKey);
  }

  // ── Timed transaction sender ────────────────────────────────────────────

  /**
   * Send a transaction, recording latency, instruction type, and success/fail
   * to ctx.metrics.
   *
   * @returns The transaction signature on success, or null on failure.
   */
  protected async sendTimed(
    tx: Transaction,
    signers: Keypair[],
    instructionName: string,
  ): Promise<string | null> {
    const startMs = Date.now();
    try {
      const sig = await sendTx(this.ctx.connection, tx, signers, {
        skipPreflight: true,
      });

      const latencyMs = Date.now() - startMs;
      this.ctx.metrics.latencies.push(latencyMs);
      this.ctx.metrics.instructionTypes.add(instructionName);
      this.ctx.metrics.orderResults.success++;

      return sig;
    } catch (e: unknown) {
      const latencyMs = Date.now() - startMs;
      this.ctx.metrics.latencies.push(latencyMs);
      this.ctx.metrics.instructionTypes.add(instructionName);
      this.ctx.metrics.orderResults.failed++;

      this.recordError(instructionName, e);
      return null;
    }
  }

  // ── Error recording ─────────────────────────────────────────────────────

  protected recordError(instruction: string, e: unknown, market?: string): void {
    let message: string;
    if (e instanceof Error) {
      message = e.message;
    } else if (typeof e === "string") {
      message = e;
    } else {
      message = String(e);
    }

    const entry: ErrorEntry = {
      timestamp: Date.now(),
      agentId: this.id,
      instruction,
      market,
      message,
    };

    this.state.errors.push(entry);
  }

  // ── Abstract act ────────────────────────────────────────────────────────

  /**
   * Execute one round of agent behavior against the given markets.
   * Implementations must NEVER throw — all errors are caught internally.
   */
  abstract act(
    markets: MarketContext[],
    oraclePrices: Map<string, bigint>,
  ): Promise<void>;
}
