import { openDB, type IDBPDatabase } from "idb";

// ---------------------------------------------------------------------------
// Types
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
// DB setup
// ---------------------------------------------------------------------------

const DB_NAME = "meridian-portfolio";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Intraday snapshots — indexed by [wallet, ts] for range queries
        if (!db.objectStoreNames.contains("snapshots")) {
          const store = db.createObjectStore("snapshots", { autoIncrement: true });
          store.createIndex("by-wallet-ts", ["wallet", "ts"]);
        }
        // Daily summaries — keyed by "wallet:date"
        if (!db.objectStoreNames.contains("daily_summaries")) {
          db.createObjectStore("daily_summaries", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Snapshot operations
// ---------------------------------------------------------------------------

export async function writeSnapshot(snapshot: PnlSnapshot): Promise<void> {
  const db = await getDb();
  await db.add("snapshots", snapshot);
}

export async function getIntradaySnapshots(
  wallet: string,
  dayStartMs: number,
): Promise<PnlSnapshot[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound([wallet, dayStartMs], [wallet, Infinity]);
  return db.getAllFromIndex("snapshots", "by-wallet-ts", range);
}

// ---------------------------------------------------------------------------
// Consolidation — collapse old intraday ticks to daily summaries
// ---------------------------------------------------------------------------

export async function consolidateOldSnapshots(wallet: string): Promise<void> {
  const db = await getDb();

  // Get today's date at market open (9:30 AM ET approximation — use midnight UTC for simplicity)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  // Get all snapshots before today for this wallet
  const range = IDBKeyRange.bound([wallet, 0], [wallet, todayMs], false, true);
  const tx = db.transaction(["snapshots", "daily_summaries"], "readwrite");
  const snapshotStore = tx.objectStore("snapshots");
  const summaryStore = tx.objectStore("daily_summaries");
  const index = snapshotStore.index("by-wallet-ts");

  const oldSnapshots: PnlSnapshot[] = await index.getAll(range);
  const keysToDelete: IDBValidKey[] = await index.getAllKeys(range);

  if (oldSnapshots.length === 0) {
    await tx.done;
    return;
  }

  // Group by date
  const byDate = new Map<string, PnlSnapshot[]>();
  for (const snap of oldSnapshots) {
    const date = new Date(snap.ts).toISOString().split("T")[0];
    const arr = byDate.get(date) ?? [];
    arr.push(snap);
    byDate.set(date, arr);
  }

  // Write daily summaries
  for (const [date, snaps] of byDate) {
    const sorted = snaps.sort((a, b) => a.ts - b.ts);
    const values = sorted.map((s) => s.totalValue);
    const summary: DailySummary & { id: string } = {
      id: `${wallet}:${date}`,
      date,
      wallet,
      openValue: values[0],
      closeValue: values[values.length - 1],
      highValue: Math.max(...values),
      lowValue: Math.min(...values),
      pnl: values[values.length - 1] - values[0],
      positionCount: sorted[sorted.length - 1].positions.length,
    };
    await summaryStore.put(summary);
  }

  // Delete old intraday ticks
  for (const key of keysToDelete) {
    await snapshotStore.delete(key);
  }

  await tx.done;
}

// ---------------------------------------------------------------------------
// Daily summary queries
// ---------------------------------------------------------------------------

export async function getDailySummaries(wallet: string): Promise<DailySummary[]> {
  const db = await getDb();
  const all = await db.getAll("daily_summaries");
  return (all as (DailySummary & { id: string })[])
    .filter((s) => s.wallet === wallet)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["snapshots", "daily_summaries"], "readwrite");
  await tx.objectStore("snapshots").clear();
  await tx.objectStore("daily_summaries").clear();
  await tx.done;
}
