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

