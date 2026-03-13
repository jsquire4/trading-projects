/**
 * Portfolio DB types.
 *
 * Previously backed by IndexedDB for client-side P&L snapshots.
 * Now the event-indexer API provides portfolio data server-side.
 *
 * This file is kept for type re-exports consumed by usePortfolioSnapshot
 * and PnlTab. The IndexedDB dependency has been removed.
 */

// ---------------------------------------------------------------------------
// Types (unchanged — consumers depend on these shapes)
// ---------------------------------------------------------------------------

export interface PositionSnapshot {
  market: string;       // market pubkey base58
  ticker: string;
  yesBal: number;       // in tokens (already divided by 1e6)
  noBal: number;
  yesValue: number;     // in USDC
  noValue: number;
}

export interface PnlSnapshot {
  ts: number;           // Unix ms
  wallet: string;       // pubkey base58
  totalValue: number;   // portfolio total in USDC
  positions: PositionSnapshot[];
}

export interface DailySummary {
  date: string;         // "YYYY-MM-DD"
  wallet: string;
  openValue: number;    // first snapshot of the day
  closeValue: number;   // last snapshot of the day
  highValue: number;
  lowValue: number;
  pnl: number;          // closeValue - openValue
  positionCount: number;
}

// ---------------------------------------------------------------------------
// Stubs — no-ops for any remaining call sites
// ---------------------------------------------------------------------------

/** @deprecated No longer writes to IndexedDB. Data comes from event-indexer. */
export async function writeSnapshot(_snapshot: PnlSnapshot): Promise<void> {
  // no-op
}

/** @deprecated No longer needed. Data comes from event-indexer. */
export async function consolidateOldSnapshots(_wallet: string): Promise<void> {
  // no-op
}

/** @deprecated No longer reads from IndexedDB. Data comes from event-indexer. */
export async function getIntradaySnapshots(
  _wallet: string,
  _dayStartMs: number,
): Promise<PnlSnapshot[]> {
  return [];
}

/** @deprecated No longer reads from IndexedDB. Data comes from event-indexer. */
export async function getDailySummaries(_wallet: string): Promise<DailySummary[]> {
  return [];
}

/** @deprecated No longer needed. */
export async function clearAllData(): Promise<void> {
  // no-op
}
