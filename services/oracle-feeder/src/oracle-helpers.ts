/**
 * Shared oracle update helpers used by both feeder.ts and synthetic-feeder.ts.
 */

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createLogger } from "../../shared/src/alerting.js";
import type { MockOracle } from "../../shared/src/idl/mock_oracle.js";

const log = createLogger("oracle-feeder:helpers");

/** Convert a dollar price (e.g. 185.42) to USDC lamports (u64). */
export function priceToLamports(price: number): BN {
  return new BN(Math.round(price * 1_000_000));
}

/** Confidence = 0.1% of price (conservative). */
export function computeConfidence(price: number): BN {
  return new BN(Math.round(price * 1_000_000 * 0.001));
}

/**
 * Push a price update on-chain to a mock_oracle PriceFeed account.
 * Includes retry logic with exponential backoff.
 */
export async function updateOnChain(
  program: Program<MockOracle>,
  authority: Keypair,
  priceFeed: PublicKey,
  ticker: string,
  price: number,
  opts?: { maxRetries?: number; baseRetryDelayMs?: number },
): Promise<boolean> {
  const maxRetries = opts?.maxRetries ?? 1;
  const baseRetryDelayMs = opts?.baseRetryDelayMs ?? 1_000;

  const priceLamports = priceToLamports(price);
  const confidence = computeConfidence(price);
  const timestamp = new BN(Math.floor(Date.now() / 1000));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await program.methods
        .updatePrice(priceLamports, confidence, timestamp)
        .accounts({
          authority: authority.publicKey,
          priceFeed,
        })
        .signers([authority])
        .rpc();

      log.info(`Updated ${ticker}: $${price.toFixed(2)}`, {
        lamports: priceLamports.toString(),
        confidence: confidence.toString(),
      });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const delay = baseRetryDelayMs * Math.pow(2, attempt - 1);
        log.warn(
          `Tx failed for ${ticker} (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`,
          { error: msg },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        log.error(
          `Tx failed for ${ticker} after ${maxRetries} attempts, dropping update`,
          { error: msg, price },
        );
      }
    }
  }
  return false;
}
