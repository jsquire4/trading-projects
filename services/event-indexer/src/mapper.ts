/**
 * Cost basis, VWAP, fills-with-intent, and portfolio queries.
 *
 * Split from db.ts for maintainability.
 */

import { getDb, type EventRow } from "./db.js";

// --------------- Cost basis aggregation ---------------

export interface CostBasisRow {
  market: string;
  side: 'yes' | 'no';
  avgPrice: number;       // weighted average fill price in cents
  totalQuantity: number;  // total tokens acquired (micro-tokens)
  totalCostUsdc: number;  // total USDC spent (in micro-USDC x cents)
  fillCount: number;
}

export function queryCostBasis(wallet: string): CostBasisRow[] {
  // Acquisition fills (cost basis = tokens obtained):
  //   - Taker buys Yes: taker = wallet AND takerSide = 0 (USDC_BID)
  //   - Taker buys No:  taker = wallet AND takerSide = 2 (NO_BID)
  //   - Maker bought Yes: maker = wallet AND makerSide = 0 (USDC_BID)
  //   - Maker bought No:  maker = wallet AND makerSide = 2 (NO_BID, merge fill)
  //   Uses makerSide (not takerSide) because takerSide=1 can match against
  //   makerSide=0 (Buy Yes) OR makerSide=2 (Sell No / merge fill).
  const stmt = getDb().prepare(`
    SELECT
      market,
      CASE
        WHEN json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 0 THEN 'yes'
        WHEN json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 2 THEN 'no'
        WHEN json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.makerSide') AS INTEGER) = 0 THEN 'yes'
        WHEN json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.makerSide') AS INTEGER) = 2 THEN 'no'
      END as side,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalQuantity,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL) * CAST(json_extract(data, '$.price') AS REAL)) as totalCost,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
      AND (
        (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) IN (0, 2))
        OR
        (json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.makerSide') AS INTEGER) IN (0, 2))
      )
    GROUP BY market, side
    HAVING side IS NOT NULL
  `);

  const rows = stmt.all({ wallet }) as { market: string; side: 'yes' | 'no'; totalQuantity: number; totalCost: number; fillCount: number }[];

  return rows.map(r => ({
    market: r.market,
    side: r.side,
    totalQuantity: r.totalQuantity,
    totalCostUsdc: r.totalCost,
    avgPrice: r.totalQuantity > 0 ? r.totalCost / r.totalQuantity : 0,
    fillCount: r.fillCount,
  }));
}

// --------------- Market VWAP aggregation ---------------

export interface MarketVwap {
  market: string;
  vwap: number;         // volume-weighted average fill price in cents
  totalVolume: number;  // total quantity filled (micro-tokens)
  fillCount: number;
}

export function queryMarketVwaps(): MarketVwap[] {
  // VWAP = sum(price * quantity) / sum(quantity) for all fills per market
  const stmt = getDb().prepare(`
    SELECT
      market,
      SUM(CAST(json_extract(data, '$.price') AS REAL) * CAST(json_extract(data, '$.quantity') AS REAL)) /
        NULLIF(SUM(CAST(json_extract(data, '$.quantity') AS REAL)), 0) as vwap,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalVolume,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
    GROUP BY market
  `);
  return stmt.all() as MarketVwap[];
}

// --------------- Fills with intent ---------------

export interface FillWithIntent {
  id: number;
  type: string;
  market: string;
  data: string;
  signature: string;
  slot: number;
  timestamp: number;
  seq: number;
  intent: string | null;
  display_price: number | null;
  viewerIntent: string;
}

/**
 * Query fills for a wallet with viewer-perspective intent labels.
 *
 * If a stored intent exists for the fill's order, use it directly.
 * Otherwise derive intent from the viewer's role (taker/maker) and side.
 *
 * Note on "Buy No" asymmetry: "Buy No" is a UI-only concept -- the user
 * submits a YES_ASK at (100 - price). On-chain, this appears as takerSide=1
 * or makerSide=1. Without a stored intent, derivation maps side 1 to
 * "sell_yes" because the on-chain action is identical. Only the stored
 * intent (from POST /api/order-intent at order submission) can distinguish
 * a "buy_no" from a "sell_yes".
 *
 * The LEFT JOIN is on makerOrderId only -- taker orders don't have a
 * persistent orderId in fill events. Taker intent derivation relies on
 * takerSide which is always unambiguous (side 0 = buy_yes, 1 = sell_yes,
 * 2 = sell_no).
 */
export function queryFillsWithIntent(wallet: string, limit: number = 50): FillWithIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT e.*, oi.intent, oi.display_price
       FROM events e
       LEFT JOIN order_intents oi
         ON CAST(json_extract(e.data, '$.makerOrderId') AS TEXT) = oi.order_id
         AND e.market = oi.market
         AND oi.wallet = @wallet
       WHERE e.type = 'fill'
         AND (json_extract(e.data, '$.taker') = @wallet
              OR json_extract(e.data, '$.maker') = @wallet)
       ORDER BY e.timestamp DESC
       LIMIT @limit`,
    )
    .all({ wallet, limit }) as (EventRow & { intent: string | null; display_price: number | null })[];

  return rows.map((row) => {
    const data = JSON.parse(row.data);
    const isTaker = data.taker === wallet;
    const takerSide = data.takerSide as number;
    const makerSide = data.makerSide as number;

    let viewerIntent: string;
    if (row.intent && data[isTaker ? 'taker' : 'maker'] === wallet) {
      // Stored intent matches viewer's order
      viewerIntent = row.intent;
    } else if (isTaker) {
      // Derive from taker's side
      viewerIntent = { 0: "buy_yes", 1: "sell_yes", 2: "sell_no" }[takerSide] ?? "unknown";
    } else {
      // Derive from maker's own resting side (makerSide is authoritative)
      viewerIntent = { 0: "buy_yes", 1: "sell_yes", 2: "sell_no" }[makerSide] ?? "unknown";
    }

    return {
      id: row.id!,
      type: row.type,
      market: row.market,
      data: row.data,
      signature: row.signature,
      slot: row.slot,
      timestamp: row.timestamp,
      seq: row.seq,
      intent: row.intent,
      display_price: row.display_price,
      viewerIntent,
    };
  });
}

// --------------- Portfolio snapshot ---------------

export interface PortfolioPosition {
  market: string;
  side: number;
  totalQuantity: number;
  totalCost: number;
  avgPrice: number;
  fillCount: number;
}

export function queryPortfolioSnapshot(wallet: string): PortfolioPosition[] {
  const stmt = getDb().prepare(`
    SELECT
      market,
      CASE
        WHEN json_extract(data, '$.taker') = @wallet THEN CAST(json_extract(data, '$.takerSide') AS INTEGER)
        ELSE CAST(json_extract(data, '$.makerSide') AS INTEGER)
      END as side,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL)) as totalQuantity,
      SUM(CAST(json_extract(data, '$.quantity') AS REAL) * CAST(json_extract(data, '$.price') AS REAL)) as totalCost,
      COUNT(*) as fillCount
    FROM events
    WHERE type = 'fill'
      AND (json_extract(data, '$.taker') = @wallet OR json_extract(data, '$.maker') = @wallet)
    GROUP BY market, side
  `);

  const rows = stmt.all({ wallet }) as { market: string; side: number; totalQuantity: number; totalCost: number; fillCount: number }[];

  return rows.map(r => ({
    market: r.market,
    side: r.side,
    totalQuantity: r.totalQuantity,
    totalCost: r.totalCost,
    avgPrice: r.totalQuantity > 0 ? Math.round(r.totalCost / r.totalQuantity) : 0,
    fillCount: r.fillCount,
  }));
}

// --------------- Portfolio history ---------------

export interface DailySummary {
  date: string;
  totalVolume: number;
  fillCount: number;
  netCostBasis: number;
}

export function queryPortfolioHistory(wallet: string, days: number): DailySummary[] {
  // netCostBasis is sign-aware: buys (sides 0, 2) are positive (cost),
  // sells (side 1) are negative (proceeds received).
  const stmt = getDb().prepare(`
    SELECT
      date(timestamp, 'unixepoch') as date,
      SUM(CAST(json_extract(data, '$.quantity') AS INTEGER)) as totalVolume,
      COUNT(*) as fillCount,
      SUM(
        CASE
          WHEN (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1)
            OR (json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.makerSide') AS INTEGER) = 1)
          THEN -(CAST(json_extract(data, '$.quantity') AS INTEGER) * CAST(json_extract(data, '$.price') AS INTEGER))
          ELSE CAST(json_extract(data, '$.quantity') AS INTEGER) * CAST(json_extract(data, '$.price') AS INTEGER)
        END
      ) as netCostBasis
    FROM events
    WHERE type = 'fill'
      AND (json_extract(data, '$.taker') = @wallet OR json_extract(data, '$.maker') = @wallet)
      AND timestamp >= unixepoch('now', '-' || @days || ' days')
    GROUP BY date
    ORDER BY date ASC
  `);

  return stmt.all({ wallet, days }) as DailySummary[];
}
