// ---------------------------------------------------------------------------
// Social proof fabrication layer — extracted from trade/page.tsx
// ---------------------------------------------------------------------------

export interface SuggestedTrade {
  ticker: string;
  currentPrice: number;
  strike: number;
  direction: "above" | "below";
  impliedProbYes: number; // 0-100
  change: number;
  changePct: number;
  momentum: "hot" | "warm" | "neutral";
  tradersActive: number; // simulated social proof
  recentWinPct: number; // simulated win rate
  simulated: true; // marks tradersActive and recentWinPct as simulated data
}

/** Deterministic-ish "random" from a string seed */
export function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash % 100) / 100;
}

export function generateSuggestedTrades(
  quotes: { symbol: string; last: number; change: number; change_percentage: number }[],
): SuggestedTrade[] {
  const today = new Date().toISOString().slice(0, 10);

  return quotes
    .filter((q) => q.last > 0)
    .map((q) => {
      const r = seededRandom(q.symbol + today);
      const strike = Math.round(q.last); // nearest whole dollar
      const direction: "above" | "below" = q.change >= 0 ? "above" : "below";

      // Probability biased toward the direction of the day's move
      const baseProbYes = direction === "above" ? 55 + r * 20 : 30 + r * 15;
      const impliedProbYes = Math.round(baseProbYes);

      // "Momentum" based on magnitude of change
      const absPct = Math.abs(q.change_percentage);
      const momentum: "hot" | "warm" | "neutral" =
        absPct > 2.5 ? "hot" : absPct > 1.0 ? "warm" : "neutral";

      // Fake social proof — grows throughout the trading day (9:30 AM - 4 PM ET)
      // Base is seeded per-ticker per-day, then ramps with time-of-day
      const now = new Date();
      const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
      const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
      const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
      const etOffset = isDST ? 4 : 5;
      const etHour = now.getUTCHours() - etOffset;
      const etMinute = etHour * 60 + now.getUTCMinutes();
      const marketOpen = 9 * 60 + 30; // 9:30 AM ET
      const marketClose = 16 * 60;    // 4:00 PM ET
      const elapsed = Math.max(0, Math.min(etMinute - marketOpen, marketClose - marketOpen));
      const dayProgress = elapsed / (marketClose - marketOpen); // 0->1 over trading day

      // Base: 15-40 at open, ramps to 150-350 by close, with per-ticker variance
      const baseMorning = 15 + Math.round(r * 25);
      const peakTraders = 150 + Math.round(seededRandom(q.symbol + today + "peak") * 200);
      // Add micro-jitter per 5-minute window so it ticks up visibly
      const fiveMinBucket = Math.floor(etMinute / 5);
      const jitter = Math.round(seededRandom(q.symbol + today + fiveMinBucket) * 8) - 4;
      const tradersActive = Math.max(baseMorning, Math.round(baseMorning + (peakTraders - baseMorning) * dayProgress) + jitter);

      const recentWinPct = 55 + Math.round(seededRandom(q.symbol + today + "w") * 25);

      return {
        ticker: q.symbol,
        currentPrice: q.last,
        strike,
        direction,
        impliedProbYes,
        change: q.change,
        changePct: q.change_percentage,
        momentum,
        tradersActive,
        recentWinPct,
        simulated: true as const,
      };
    })
    .sort((a, b) => {
      // Hot first, then by absolute change
      const mOrder = { hot: 0, warm: 1, neutral: 2 };
      if (mOrder[a.momentum] !== mOrder[b.momentum])
        return mOrder[a.momentum] - mOrder[b.momentum];
      return Math.abs(b.changePct) - Math.abs(a.changePct);
    });
}
