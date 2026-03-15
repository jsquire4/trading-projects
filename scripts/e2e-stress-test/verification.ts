/**
 * verification.ts — End-of-day and cross-day verification checks.
 *
 * Every check is wrapped in try/catch so verification itself never throws.
 * Returns { passed, violations, warnings } where passed = violations.length === 0.
 */

import { getMint } from "@solana/spl-token";
import type {
  SharedContext,
  DayResult,
  VerificationResult,
  MarketContext,
} from "./types";
import {
  readMarketState,
  readVaultBalance,
  parseOrderBook,
} from "./helpers";

// ─── Day-end verification ─────────────────────────────────────────────────────

/**
 * Verify invariants at the end of a single simulated day.
 *
 * Checks:
 *  1. All markets for this day are settled on-chain.
 *  2. Vault balances for settled markets (warning if nonzero).
 *  3. Order books are empty for markets that have been closed.
 *  4. No agent has a negative USDC balance.
 */
export async function verifyDayEnd(
  ctx: SharedContext,
  day: number,
  dayResult: DayResult,
): Promise<VerificationResult> {
  const violations: string[] = [];
  const warnings: string[] = [];

  const dayMarkets = ctx.markets.filter((m) => m.day === day);

  // 1. All markets for this day must be settled (or fully closed/destroyed)
  for (const m of dayMarkets) {
    try {
      const state = await readMarketState(ctx.connection, m.market);
      if (!state) {
        // Account not found = destroyed by close_market — this is correct behavior
        continue;
      }
      if (!state.isSettled) {
        violations.push(
          `[Day ${day}] Market ${m.ticker} (${m.market.toBase58().slice(0, 8)}…) ` +
            `is NOT settled on-chain`,
        );
      }
    } catch (err: any) {
      violations.push(
        `[Day ${day}] Failed to read market state for ${m.ticker}: ${err.message}`,
      );
    }
  }

  // 2. Vault balance — unexpected remaining balance is a warning
  for (const m of dayMarkets) {
    try {
      const balance = await readVaultBalance(ctx.connection, m.usdcVault);
      if (balance > 0n) {
        warnings.push(
          `[Day ${day}] Market ${m.ticker} vault has ${balance} remaining ` +
            `(may not be closed yet)`,
        );
      }
    } catch (err: any) {
      warnings.push(
        `[Day ${day}] Could not read vault for ${m.ticker}: ${err.message}`,
      );
    }
  }

  // 3. Order book empty for closed markets
  for (const m of dayMarkets) {
    try {
      const state = await readMarketState(ctx.connection, m.market);
      if (!state || !state.isSettled) continue; // only check settled markets

      const obAcct = await ctx.connection.getAccountInfo(m.orderBook);
      if (!obAcct) continue; // account may be reclaimed

      const activeOrders = parseOrderBook(Buffer.from(obAcct.data));
      if (activeOrders.length > 0) {
        violations.push(
          `[Day ${day}] Market ${m.ticker} is closed but order book has ` +
            `${activeOrders.length} active order(s)`,
        );
      }
    } catch (err: any) {
      warnings.push(
        `[Day ${day}] Could not check order book for ${m.ticker}: ${err.message}`,
      );
    }
  }

  // 4. No agent has negative USDC balance
  for (const agent of ctx.agents) {
    try {
      if (agent.currentUsdc < 0n) {
        violations.push(
          `[Day ${day}] Agent ${agent.id} (${agent.type}) has negative USDC ` +
            `balance: ${agent.currentUsdc}`,
        );
      }
    } catch {
      // currentUsdc is a bigint field; comparison should never throw
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

// ─── Cross-day verification ───────────────────────────────────────────────────

/**
 * Verify cross-day invariants after the full simulation.
 *
 * Checks:
 *  1. Markets on different days have different marketCloseUnix values.
 *  2. Token supply for closed markets should be zero (warning if not).
 *  3. Fill rate >= 20%.
 *  4. At least 50% of agents participated.
 */
export async function verifyCrossDay(
  ctx: SharedContext,
  days: DayResult[],
): Promise<VerificationResult> {
  const violations: string[] = [];
  const warnings: string[] = [];

  // 1. Separate days — day 0 markets must have different marketCloseUnix
  //    than day 1 markets, etc.
  const closeUnixByDay = new Map<number, Set<number>>();
  for (const m of ctx.markets) {
    if (!closeUnixByDay.has(m.day)) {
      closeUnixByDay.set(m.day, new Set());
    }
    closeUnixByDay.get(m.day)!.add(m.marketCloseUnix);
  }

  const dayNumbers = [...closeUnixByDay.keys()].sort((a, b) => a - b);
  for (let i = 1; i < dayNumbers.length; i++) {
    const prevSet = closeUnixByDay.get(dayNumbers[i - 1])!;
    const currSet = closeUnixByDay.get(dayNumbers[i])!;
    for (const ts of currSet) {
      if (prevSet.has(ts)) {
        violations.push(
          `Day ${dayNumbers[i]} shares marketCloseUnix ${ts} with day ${dayNumbers[i - 1]}`,
        );
      }
    }
  }

  // 2. Token supply zero for closed markets
  const closedMarkets = ctx.markets.filter((m) => {
    // Consider a market "closed" if it appears in a day that has been fully processed
    return days.some((d) => d.day === m.day);
  });

  for (const m of closedMarkets) {
    try {
      const yesMintInfo = await getMint(ctx.connection, m.yesMint);
      const noMintInfo = await getMint(ctx.connection, m.noMint);
      const totalSupply = yesMintInfo.supply + noMintInfo.supply;
      if (totalSupply > 0n) {
        warnings.push(
          `Market ${m.ticker} day ${m.day}: token supply not zero ` +
            `(yes=${yesMintInfo.supply}, no=${noMintInfo.supply}) — ` +
            `some tokens may not be redeemed yet`,
        );
      }
    } catch (err: any) {
      warnings.push(
        `Could not read mint supply for ${m.ticker} day ${m.day}: ${err.message}`,
      );
    }
  }

  // 3. Fill rate >= 20%
  const totalPlaced = days.reduce((s, d) => s + d.ordersPlaced, 0);
  const totalFilled = days.reduce((s, d) => s + d.ordersFilled, 0);
  const fillRate = totalPlaced > 0 ? totalFilled / totalPlaced : 0;

  if (fillRate < 0.2) {
    warnings.push(
      `Overall fill rate is ${(fillRate * 100).toFixed(1)}% ` +
        `(${totalFilled}/${totalPlaced}), below 20% threshold`,
    );
  }

  // 4. Agent participation — at least 50% placed at least one order
  const participatingAgents = ctx.agents.filter((a) => a.ordersPlaced > 0).length;
  const participationRate =
    ctx.agents.length > 0 ? participatingAgents / ctx.agents.length : 0;

  if (participationRate < 0.5) {
    warnings.push(
      `Agent participation is ${(participationRate * 100).toFixed(1)}% ` +
        `(${participatingAgents}/${ctx.agents.length}), below 50% threshold`,
    );
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

// ─── Rent accounting verification ────────────────────────────────────────────

/**
 * Verify rent accounting invariants across all agents.
 *
 * For the sparse order book, users deposit SOL rent when placing orders
 * at new price levels, and get it returned on cancel/fill/settlement.
 * This check verifies the accounting is balanced.
 *
 * Note: This is a soft check — rent tracking in the stress test is
 * best-effort since we don't intercept every lamport transfer.
 */
export async function verifyRentAccounting(
  ctx: SharedContext,
): Promise<VerificationResult> {
  const violations: string[] = [];
  const warnings: string[] = [];

  let totalDeposited = 0n;
  let totalReturned = 0n;

  for (const agent of ctx.agents) {
    totalDeposited += agent.rentDeposited;
    totalReturned += agent.rentReturned;
  }

  // If rent tracking was active, check balance
  if (totalDeposited > 0n || totalReturned > 0n) {
    if (totalReturned > totalDeposited) {
      violations.push(
        `Rent accounting imbalance: returned (${totalReturned}) > deposited (${totalDeposited})`,
      );
    } else {
      const unreturned = totalDeposited - totalReturned;
      if (unreturned > 0n) {
        warnings.push(
          `${unreturned} lamports of rent not yet returned ` +
            `(deposited=${totalDeposited}, returned=${totalReturned}) — ` +
            `may be in still-open order book accounts`,
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}
