/**
 * metrics.ts — Transaction metrics collector for the Really Stressful Test.
 * Tracks latencies, TPS over time, instruction types, success/failure rates,
 * and error frequencies.
 */

import type { Metrics, TpsPoint } from "./types";

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export class MetricsCollector {
  readonly data: Metrics;
  private windowStart: number;
  private windowCount: number;

  constructor() {
    this.data = {
      tpsTimeline: [],
      latencies: [],
      orderResults: {
        success: 0,
        failed: 0,
        errors: new Map<string, number>(),
      },
      fillRate: 0,
      mergeCount: 0,
      instructionTypes: new Set<string>(),
    };
    this.windowStart = Date.now();
    this.windowCount = 0;
  }

  /**
   * Record a completed transaction.
   */
  recordTx(
    latencyMs: number,
    instructionName: string,
    success: boolean,
    errorMsg?: string,
  ): void {
    this.data.latencies.push(latencyMs);
    this.data.instructionTypes.add(instructionName);
    this.windowCount++;

    if (success) {
      this.data.orderResults.success++;
    } else {
      this.data.orderResults.failed++;
      if (errorMsg) {
        const current = this.data.orderResults.errors.get(errorMsg) ?? 0;
        this.data.orderResults.errors.set(errorMsg, current + 1);
      }
    }
  }

  /**
   * Record a merge event (Yes + No token merge into USDC).
   */
  recordMerge(): void {
    this.data.mergeCount++;
  }

  /**
   * Flush the current TPS measurement window and start a new one.
   * Calculates TPS as transactions in window / elapsed seconds.
   */
  flushTpsWindow(): void {
    const now = Date.now();
    const elapsedSec = (now - this.windowStart) / 1000;

    if (elapsedSec > 0) {
      const tps = this.windowCount / elapsedSec;
      const point: TpsPoint = {
        timestamp: now,
        tps,
      };
      this.data.tpsTimeline.push(point);
    }

    this.windowStart = now;
    this.windowCount = 0;
  }

  /**
   * Finalize metrics after the test run completes.
   * Computes fill rate from total orders placed vs filled.
   */
  finalize(totalPlaced: number, totalFilled: number): void {
    this.data.fillRate = totalPlaced > 0 ? totalFilled / totalPlaced : 0;
  }
}
