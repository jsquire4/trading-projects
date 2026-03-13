/**
 * oracle.ts — Oracle price simulator for the E2E Stress Test.
 * Uses GBM (Geometric Brownian Motion) to produce deterministic, realistic
 * price movements. Updates on-chain mock oracle feeds.
 */

import { Transaction } from "@solana/web3.js";
import BN from "bn.js";
import type { SharedContext } from "./types";
import { CONFIDENCE_BPS_OF_PRICE } from "./config";
import { SeededRng, gbmStep, hashSeed, BASE_PRICES } from "../../services/shared/src/synthetic-config";
import { buildUpdatePriceIx } from "../../tests/helpers/instructions";
import { sendTx, findPriceFeed } from "./helpers";

// ---------------------------------------------------------------------------
// OracleSimulator
// ---------------------------------------------------------------------------

export class OracleSimulator {
  private prices: Map<string, number>;
  private rngs: Map<string, SeededRng>;

  constructor(tickers: string[], globalSeed: number) {
    this.prices = new Map();
    this.rngs = new Map();

    for (const ticker of tickers) {
      const basePrice = BASE_PRICES[ticker] ?? 100;
      this.prices.set(ticker, basePrice);
      this.rngs.set(ticker, new SeededRng(hashSeed(globalSeed, ticker)));
    }
  }

  /**
   * Advance the price for a single ticker by one GBM step.
   * @returns The new dollar price.
   */
  stepPrice(ticker: string): number {
    const currentPrice = this.prices.get(ticker);
    const rng = this.rngs.get(ticker);
    if (currentPrice === undefined || !rng) {
      throw new Error(`OracleSimulator: unknown ticker "${ticker}"`);
    }

    const newPrice = gbmStep(currentPrice, rng);
    this.prices.set(ticker, newPrice);
    return newPrice;
  }

  /**
   * Get the current price in USDC lamports (dollars * 1_000_000).
   */
  getPriceLamports(ticker: string): bigint {
    const price = this.prices.get(ticker);
    if (price === undefined) {
      throw new Error(`OracleSimulator: unknown ticker "${ticker}"`);
    }
    return BigInt(Math.round(price * 1_000_000));
  }

  /**
   * Get all current prices as a Map of ticker -> USDC lamports.
   */
  getAllPrices(): Map<string, bigint> {
    const result = new Map<string, bigint>();
    for (const [ticker] of this.prices) {
      result.set(ticker, this.getPriceLamports(ticker));
    }
    return result;
  }

  /**
   * Update the on-chain oracle price for a single ticker.
   * Uses timestamp = now - 2 seconds to pass the staleness check.
   */
  async updateOraclePrice(ctx: SharedContext, ticker: string): Promise<void> {
    const priceLamports = this.getPriceLamports(ticker);
    const confidence = Math.floor(
      Number(priceLamports) * CONFIDENCE_BPS_OF_PRICE / 10_000,
    );

    // CRITICAL: -2 seconds for on-chain staleness check
    const timestamp = Math.floor(Date.now() / 1000) - 2;

    const [priceFeed] = findPriceFeed(ticker);

    const ix = buildUpdatePriceIx({
      authority: ctx.admin.publicKey,
      priceFeed,
      price: new BN(priceLamports.toString()),
      confidence: new BN(confidence),
      timestamp: new BN(timestamp),
    });

    const tx = new Transaction().add(ix);
    await sendTx(ctx.connection, tx, [ctx.admin], { skipPreflight: true });
  }

  /**
   * Step and update all oracle prices on-chain.
   */
  async updateAllPrices(ctx: SharedContext): Promise<void> {
    for (const ticker of this.prices.keys()) {
      this.stepPrice(ticker);
      await this.updateOraclePrice(ctx, ticker);
    }
  }
}
