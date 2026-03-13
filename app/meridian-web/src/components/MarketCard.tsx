"use client";

import { useState } from "react";
import Link from "next/link";
import { TradeModal } from "@/components/TradeModal";

export interface MarketData {
  ticker: string;
  strikePrice: number; // USDC lamports
  isSettled: boolean;
  outcome: number; // 0 = not settled, 1 = yes wins, 2 = no wins
  bestBid: number | null; // cents (1-99)
  bestAsk: number | null; // cents (1-99)
  activeOrders?: number;
  marketCloseUnix?: number;
}

interface MarketCardProps {
  market: MarketData;
}

function formatSettlementDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function statusBadge(isSettled: boolean, outcome: number, marketCloseUnix?: number) {
  if (!isSettled) {
    const now = Math.floor(Date.now() / 1000);
    if (marketCloseUnix != null && now >= marketCloseUnix) {
      return (
        <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-[10px] font-medium text-yellow-400">
          Awaiting Settlement
        </span>
      );
    }
    // Next-day market (>=12h until close)
    if (marketCloseUnix != null && (marketCloseUnix - now) >= 12 * 3600) {
      return (
        <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-400">
          {formatSettlementDate(marketCloseUnix)}
        </span>
      );
    }
    return (
      <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
        Active
      </span>
    );
  }
  if (outcome === 1) {
    return (
      <span className="rounded-full bg-yes/20 px-2 py-0.5 text-[10px] font-medium text-yes">
        Settled - Yes Wins
      </span>
    );
  }
  return (
    <span className="rounded-full bg-no/20 px-2 py-0.5 text-[10px] font-medium text-no">
      Settled - No Wins
    </span>
  );
}

export function MarketCard({ market }: MarketCardProps) {
  const {
    ticker,
    strikePrice,
    isSettled,
    outcome,
    bestBid,
    bestAsk,
    activeOrders,
    marketCloseUnix,
  } = market;

  const [tradeModalOpen, setTradeModalOpen] = useState(false);

  // Midpoint price for Yes, or best bid/ask
  const yesPrice = bestBid !== null && bestAsk !== null
    ? Math.round((bestBid + bestAsk) / 2)
    : bestBid ?? bestAsk ?? null;

  // Complementary pricing: Yes + No = 100c ($1.00). This is a fundamental
  // property of binary outcomes — one of Yes/No always wins, paying $1.
  const noPrice = yesPrice !== null ? 100 - yesPrice : null;
  const impliedProb = yesPrice !== null ? yesPrice : null;
  const strikeDollars = (strikePrice / 1_000_000).toFixed(2);

  const cardContent = (
    <>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-lg font-bold text-white">{ticker}</h3>
          <p className="text-xs text-white/50">Strike: ${strikeDollars}</p>
        </div>
        {statusBadge(isSettled, outcome, marketCloseUnix)}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="rounded-md bg-yes/10 px-3 py-2 text-center">
          <div className="text-[10px] uppercase tracking-wider text-yes/70">Yes</div>
          <div className="text-lg font-bold text-yes">
            {yesPrice !== null ? `${yesPrice}c` : "--"}
          </div>
        </div>
        <div className="rounded-md bg-no/10 px-3 py-2 text-center">
          <div className="text-[10px] uppercase tracking-wider text-no/70">No</div>
          <div className="text-lg font-bold text-no">
            {noPrice !== null ? `${noPrice}c` : "--"}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-white/50">
        <span>
          Implied:{" "}
          <span className="text-white/70">
            {impliedProb !== null ? `${impliedProb}%` : "--"}
          </span>
        </span>
        <div className="flex items-center gap-2">
          {bestBid !== null && bestAsk !== null && (
            <span className="text-white/40">
              Spread: <span className="text-white/60">{bestAsk - bestBid}c</span>
            </span>
          )}
          {activeOrders !== undefined && (
            <span>
              {activeOrders} order{activeOrders !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );

  // Settled markets go directly to trade page; active markets open TradeModal
  if (isSettled) {
    return (
      <Link
        href={`/trade/${ticker}`}
        className="block rounded-lg border border-white/10 bg-white/5 p-4 transition-colors hover:border-white/20 hover:bg-white/[0.07]"
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <>
      <div
        onClick={() => setTradeModalOpen(true)}
        className="block rounded-lg border border-white/10 bg-white/5 p-4 transition-colors hover:border-white/20 hover:bg-white/[0.07] cursor-pointer"
      >
        {cardContent}
      </div>
      <TradeModal
        open={tradeModalOpen}
        onClose={() => setTradeModalOpen(false)}
        ticker={ticker}
        strike={strikePrice / 1_000_000}
        currentPrice={yesPrice !== null ? yesPrice / 100 : undefined}
        price={yesPrice ?? undefined}
      />
    </>
  );
}
