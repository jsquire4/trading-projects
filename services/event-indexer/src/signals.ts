/**
 * Signals Computation Engine
 *
 * Computes the Meridian Index (aggregate MAG7 sentiment) and
 * Time-Weighted Conviction Scores from fill and settlement data.
 */

import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketTickerRow {
  market: string;
  ticker: string;
  strike: number;
  close_unix: number;
}

export interface TickerIndexEntry {
  ticker: string;
  vwap: number;
  volume: number;
  fillCount: number;
}

export interface MeridianIndexResult {
  value: number;
  dispersion: number;
  tickers: TickerIndexEntry[];
  timestamp: number;
}

export interface ConvictionResult {
  wallet: string;
  score: number;
  trades: number;
  winRate: number;
  byTicker: { ticker: string; score: number; trades: number }[];
}

export interface ConvictionLeader {
  wallet: string;
  score: number;
  trades: number;
  winRate: number;
  topTicker: string;
}

export interface SmartMoneySignal {
  ticker: string;
  direction: "yes" | "no";
  strength: number;
  fillCount: number;
  avgConviction: number;
}

export interface IndexSnapshotRow {
  id?: number;
  timestamp: number;
  value: number;
  dispersion: number;
  tickers: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAG7 = ["AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "META", "TSLA"];
const MARKET_OPEN_SECS = 9 * 3600 + 30 * 60; // 9:30 AM
const MARKET_CLOSE_SECS = 16 * 3600; // 4:00 PM
const TRADING_WINDOW_SECS = MARKET_CLOSE_SECS - MARKET_OPEN_SECS; // 23400

/** Get the ET offset in seconds. EST = 5h, EDT = 4h. */
function etOffsetSeconds(): number {
  // Use Intl to detect current ET offset (handles DST correctly)
  const now = new Date();
  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const utcMin = parseInt(utcParts.find(p => p.type === "hour")?.value ?? "0") * 60
    + parseInt(utcParts.find(p => p.type === "minute")?.value ?? "0");
  const etMin = parseInt(etParts.find(p => p.type === "hour")?.value ?? "0") * 60
    + parseInt(etParts.find(p => p.type === "minute")?.value ?? "0");
  let diff = utcMin - etMin;
  if (diff < 0) diff += 24 * 60;
  if (diff > 12 * 60) diff -= 24 * 60;
  return diff * 60; // convert minutes to seconds
}

/** Unix timestamp of today's 9:30 AM ET. */
function todayOpenUnix(): number {
  const offset = etOffsetSeconds();
  const nowUnix = Math.floor(Date.now() / 1000);
  const dayStartUtc = Math.floor((nowUnix + offset) / 86400) * 86400 - offset;
  return dayStartUtc + MARKET_OPEN_SECS;
}

// ---------------------------------------------------------------------------
// Market Tickers CRUD
// ---------------------------------------------------------------------------

export function upsertMarketTicker(row: MarketTickerRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO market_tickers (market, ticker, strike, close_unix)
       VALUES (@market, @ticker, @strike, @close_unix)`,
    )
    .run(row);
}

// ---------------------------------------------------------------------------
// Index Snapshots CRUD
// ---------------------------------------------------------------------------

export function insertIndexSnapshot(
  value: number,
  dispersion: number,
  tickers: Record<string, { vwap: number; volume: number }>,
): void {
  getDb()
    .prepare(
      `INSERT INTO index_snapshots (timestamp, value, dispersion, tickers)
       VALUES (@timestamp, @value, @dispersion, @tickers)`,
    )
    .run({
      timestamp: Math.floor(Date.now() / 1000),
      value,
      dispersion,
      tickers: JSON.stringify(tickers),
    });
}

export function queryIndexSnapshots(opts: {
  periodSeconds: number;
  limit?: number;
}): IndexSnapshotRow[] {
  const since = Math.floor(Date.now() / 1000) - opts.periodSeconds;
  return getDb()
    .prepare(
      `SELECT * FROM index_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(since, opts.limit ?? 500) as IndexSnapshotRow[];
}

// ---------------------------------------------------------------------------
// Meridian Index
// ---------------------------------------------------------------------------

export function computeMeridianIndex(): MeridianIndexResult {
  const db = getDb();
  const openUnix = todayOpenUnix();
  const nowUnix = Math.floor(Date.now() / 1000);

  // Wrap in a read transaction for snapshot consistency across all 7 ticker queries
  return db.transaction(() => _computeMeridianIndexInner(db, openUnix, nowUnix))();
}

function _computeMeridianIndexInner(db: ReturnType<typeof getDb>, openUnix: number, nowUnix: number): MeridianIndexResult {
  const entries: TickerIndexEntry[] = [];

  for (const ticker of MAG7) {
    const markets = db
      .prepare("SELECT market FROM market_tickers WHERE ticker = ?")
      .all(ticker) as { market: string }[];

    if (markets.length === 0) {
      entries.push({ ticker, vwap: 50, volume: 0, fillCount: 0 });
      continue;
    }

    const placeholders = markets.map(() => "?").join(",");
    const pubkeys = markets.map((m) => m.market);

    // Today's fills VWAP
    const row = db
      .prepare(
        `SELECT
           SUM(CAST(json_extract(data,'$.price') AS REAL) * CAST(json_extract(data,'$.quantity') AS REAL)) as sumPV,
           SUM(CAST(json_extract(data,'$.quantity') AS REAL)) as sumV,
           COUNT(*) as cnt
         FROM events
         WHERE type = 'fill' AND market IN (${placeholders})
           AND timestamp >= ? AND timestamp <= ?`,
      )
      .get([...pubkeys, openUnix, nowUnix]) as {
      sumPV: number | null;
      sumV: number | null;
      cnt: number;
    };

    if (row.sumV && row.sumV > 0) {
      entries.push({
        ticker,
        vwap: row.sumPV! / row.sumV,
        volume: row.sumV,
        fillCount: row.cnt,
      });
      continue;
    }

    // Fallback: all-time VWAP for this ticker's markets
    const hist = db
      .prepare(
        `SELECT
           SUM(CAST(json_extract(data,'$.price') AS REAL) * CAST(json_extract(data,'$.quantity') AS REAL)) /
             NULLIF(SUM(CAST(json_extract(data,'$.quantity') AS REAL)), 0) as vwap,
           SUM(CAST(json_extract(data,'$.quantity') AS REAL)) as sumV,
           COUNT(*) as cnt
         FROM events
         WHERE type = 'fill' AND market IN (${placeholders})`,
      )
      .get(pubkeys) as { vwap: number | null; sumV: number | null; cnt: number };

    entries.push({
      ticker,
      vwap: hist.vwap ?? 50,
      volume: hist.sumV ?? 0,
      fillCount: hist.cnt,
    });
  }

  // Volume-weighted index
  const totalVol = entries.reduce((s, e) => s + e.volume, 0);
  const value =
    totalVol > 0
      ? entries.reduce((s, e) => s + e.vwap * e.volume, 0) / totalVol
      : entries.reduce((s, e) => s + e.vwap, 0) / entries.length;

  // Dispersion (population stdev)
  const mean = entries.reduce((s, e) => s + e.vwap, 0) / entries.length;
  const variance =
    entries.reduce((s, e) => s + (e.vwap - mean) ** 2, 0) / entries.length;
  const dispersion = Math.sqrt(variance);

  return {
    value,
    dispersion,
    tickers: entries,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Conviction Scores
// ---------------------------------------------------------------------------

interface FillScoreRow {
  market: string;
  ticker: string;
  wallet: string;
  takerSide: number;
  fillPrice: number;
  fill_ts: number;
  outcome: number;
}

function scoreFill(row: FillScoreRow): { term: number; correct: boolean } {
  const offset = etOffsetSeconds();
  const dayStartUtc =
    Math.floor((row.fill_ts + offset) / 86400) * 86400 - offset;
  const closeUnix = dayStartUtc + MARKET_CLOSE_SECS;

  const timeWeight = Math.max(
    0,
    Math.min(1, (closeUnix - row.fill_ts) / TRADING_WINDOW_SECS),
  );
  const probabilityEdge = Math.abs(row.fillPrice - 50) / 50;
  const convictionRaw = timeWeight * (1 - probabilityEdge);

  // outcome=1 → Yes wins. takerSide 0=bought Yes, 1=sold Yes, 2=bought No
  const correct =
    (row.outcome === 1 && row.takerSide === 0) ||
    (row.outcome === 2 && (row.takerSide === 1 || row.takerSide === 2));
  const correctness = correct ? 1 : -0.5;

  return { term: convictionRaw * correctness, correct };
}

export function computeConvictionScores(
  wallet?: string,
): ConvictionResult[] {
  const db = getDb();

  // Use a subquery to get exactly one settlement per market (the first one),
  // preventing Cartesian products if a market has multiple settlement events.
  const query = `
    SELECT
      f.market,
      mt.ticker,
      json_extract(f.data, '$.taker') as wallet,
      CAST(json_extract(f.data, '$.takerSide') AS INTEGER) as takerSide,
      CAST(json_extract(f.data, '$.price') AS REAL) as fillPrice,
      f.timestamp as fill_ts,
      CAST(json_extract(s.data, '$.outcome') AS INTEGER) as outcome
    FROM events f
    JOIN (
      SELECT market, data, MIN(rowid) as rid
      FROM events WHERE type = 'settlement'
      GROUP BY market
    ) s ON f.market = s.market
    JOIN market_tickers mt ON f.market = mt.market
    WHERE f.type = 'fill'
      ${wallet ? "AND json_extract(f.data, '$.taker') = ?" : ""}
  `;

  const rows = (
    wallet ? db.prepare(query).all(wallet) : db.prepare(query).all()
  ) as FillScoreRow[];

  // Group by wallet → ticker
  const byWallet = new Map<
    string,
    Map<string, { term: number; correct: boolean }[]>
  >();
  for (const row of rows) {
    if (!byWallet.has(row.wallet)) byWallet.set(row.wallet, new Map());
    const tMap = byWallet.get(row.wallet)!;
    if (!tMap.has(row.ticker)) tMap.set(row.ticker, []);
    tMap.get(row.ticker)!.push(scoreFill(row));
  }

  return Array.from(byWallet.entries()).map(([w, tickerMap]) => {
    const all = Array.from(tickerMap.values()).flat();
    const n = all.length;
    const sumTerm = all.reduce((s, x) => s + x.term, 0);
    const wins = all.filter((x) => x.correct).length;

    const byTicker = Array.from(tickerMap.entries()).map(([t, scores]) => ({
      ticker: t,
      score:
        scores.length > 0
          ? scores.reduce((s, x) => s + x.term, 0) / Math.sqrt(scores.length)
          : 0,
      trades: scores.length,
    }));

    return {
      wallet: w,
      score: n > 0 ? sumTerm / Math.sqrt(n) : 0,
      trades: n,
      winRate: n > 0 ? wins / n : 0,
      byTicker,
    };
  });
}

export function computeConvictionLeaders(
  limit: number = 20,
): ConvictionLeader[] {
  return computeConvictionScores()
    .filter((r) => r.trades >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      wallet: r.wallet,
      score: r.score,
      trades: r.trades,
      winRate: r.winRate,
      topTicker:
        r.byTicker.slice().sort((a, b) => b.trades - a.trades)[0]?.ticker ?? "",
    }));
}

// ---------------------------------------------------------------------------
// Smart Money Flow
// ---------------------------------------------------------------------------

export function computeSmartMoney(): SmartMoneySignal[] {
  const db = getDb();
  const openUnix = todayOpenUnix();
  const nowUnix = Math.floor(Date.now() / 1000);

  // Unsettled markets
  const unsettled = db
    .prepare(
      `SELECT mt.market, mt.ticker FROM market_tickers mt
       WHERE NOT EXISTS (SELECT 1 FROM events s WHERE s.market = mt.market AND s.type = 'settlement')`,
    )
    .all() as { market: string; ticker: string }[];

  if (unsettled.length === 0) return [];

  const placeholders = unsettled.map(() => "?").join(",");
  const pubkeys = unsettled.map((m) => m.market);
  const tickerByMarket = new Map(unsettled.map((m) => [m.market, m.ticker]));

  const fills = db
    .prepare(
      `SELECT market,
              CAST(json_extract(data, '$.takerSide') AS INTEGER) as takerSide,
              CAST(json_extract(data, '$.price') AS REAL) as price,
              timestamp as fill_ts
       FROM events
       WHERE type = 'fill' AND market IN (${placeholders})
         AND timestamp >= ? AND timestamp <= ?`,
    )
    .all([...pubkeys, openUnix, nowUnix]) as {
    market: string;
    takerSide: number;
    price: number;
    fill_ts: number;
  }[];

  const acc = new Map<string, { strength: number; fillCount: number }>();
  const offset = etOffsetSeconds();

  for (const fill of fills) {
    const ticker = tickerByMarket.get(fill.market) ?? "UNKNOWN";
    const dayStartUtc =
      Math.floor((fill.fill_ts + offset) / 86400) * 86400 - offset;
    const closeUnix = dayStartUtc + MARKET_CLOSE_SECS;
    const timeWeight = Math.max(
      0,
      Math.min(1, (closeUnix - fill.fill_ts) / TRADING_WINDOW_SECS),
    );
    const probabilityEdge = Math.abs(fill.price - 50) / 50;
    const convictionRaw = timeWeight * (1 - probabilityEdge);

    const direction: "yes" | "no" = fill.takerSide === 0 ? "yes" : "no";
    const key = `${ticker}:${direction}`;
    const cur = acc.get(key) ?? { strength: 0, fillCount: 0 };
    acc.set(key, {
      strength: cur.strength + convictionRaw,
      fillCount: cur.fillCount + 1,
    });
  }

  return Array.from(acc.entries())
    .map(([key, val]) => {
      const [ticker, direction] = key.split(":") as [string, "yes" | "no"];
      return {
        ticker,
        direction,
        strength: val.strength,
        fillCount: val.fillCount,
        avgConviction:
          val.fillCount > 0 ? val.strength / val.fillCount : 0,
      };
    })
    .sort((a, b) => b.strength - a.strength);
}
