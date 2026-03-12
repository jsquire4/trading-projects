/**
 * tx-helpers.ts — Transaction-level helpers for bankrun tests.
 */

import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

/**
 * Create a factory that produces unique ComputeBudgetProgram.setComputeUnitLimit
 * instructions. Each call increments an internal counter, preventing bankrun's
 * "already processed" deduplication across transactions in the same test run.
 *
 * @param startNonce  Starting CU limit value (must be unique across factories in the same test file)
 */
export function makeUniqueCuIxFactory(startNonce = 200_000): () => TransactionInstruction {
  let cuNonce = startNonce;
  return () => {
    cuNonce += 1;
    return ComputeBudgetProgram.setComputeUnitLimit({ units: cuNonce });
  };
}
