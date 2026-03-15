"use client";

import { useMemo, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarkets, useOrderBook, type ParsedMarket } from "@/hooks/useMarkets";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { OraclePrice } from "@/components/OraclePrice";
import { SettlementStatus } from "@/components/SettlementStatus";
import { SettleButton } from "@/components/SettleButton";
import { OrderTree } from "@/components/OrderTree";
import { getExplorerUrl } from "@/lib/network";

// ---------------------------------------------------------------------------
// Analytics Banner
// ---------------------------------------------------------------------------

function AnalyticsBanner({
  ticker,
  market,
}: {
  ticker: string;
  market: ParsedMarket | null;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link
            href="/trade"
            className="text-white/30 hover:text-white/60 transition-colors text-sm"
          >
            &larr;
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-white">{ticker}</h1>
              {market?.isSettled && (
                <span className="px-2 py-0.5 rounded bg-accent/20 text-accent text-[10px] font-medium">
                  SETTLED
                </span>
              )}
            </div>
            <OraclePrice ticker={ticker} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {market && (
            <>
              <SettlementStatus
                marketCloseUnix={Number(market.marketCloseUnix)}
                isSettled={market.isSettled}
                outcome={market.outcome}
                overrideDeadline={Number(market.overrideDeadline)}
                settlementPrice={Number(market.settlementPrice)}
                strikePrice={Number(market.strikePrice)}
              />
              <SettleButton market={market} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Orders (Ticker-Level)
// ---------------------------------------------------------------------------

function MyOrdersPanel({
  ticker,
  markets,
}: {
  ticker: string;
  markets: ParsedMarket[];
}) {
  const { publicKey } = useWallet();

  if (!publicKey) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10">
        <h3 className="text-sm font-semibold text-white/80">My Orders — {ticker}</h3>
      </div>
      <div className="px-4 py-3">
        {markets.length === 0 ? (
          <p className="text-xs text-white/30">No active markets to show orders for.</p>
        ) : (
          <p className="text-xs text-white/40">
            Your open and filled orders across all {ticker} strikes will appear here.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strike Tabs
// ---------------------------------------------------------------------------

function StrikeTabs({
  markets,
  selectedKey,
  onSelect,
  onNewStrike,
  showingNewStrike,
}: {
  markets: ParsedMarket[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onNewStrike: () => void;
  showingNewStrike: boolean;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <span className="text-xs text-white/40 shrink-0">Strike:</span>
      {markets.map((m) => {
        const strike = (Number(m.strikePrice) / 1_000_000).toFixed(0);
        const key = m.publicKey.toBase58();
        const isSelected = key === selectedKey && !showingNewStrike;

        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`px-3 py-1 rounded-md text-sm font-mono transition-all shrink-0 ${
              isSelected
                ? "bg-accent/20 text-accent border border-accent/30"
                : "bg-white/5 text-white/50 border border-white/10 hover:text-white/80"
            }`}
          >
            ${strike}
          </button>
        );
      })}
      <button
        onClick={onNewStrike}
        className={`px-3 py-1 rounded-md text-sm font-medium transition-all shrink-0 ${
          showingNewStrike
            ? "bg-accent/20 text-accent border border-accent/30"
            : "bg-white/5 text-white/50 border border-dashed border-white/20 hover:text-white/80 hover:border-white/30"
        }`}
      >
        + New Strike
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradingCockpit({
  params,
}: {
  params: { ticker: string };
}) {
  const ticker = params.ticker.toUpperCase();
  const searchParams = useSearchParams();
  const { data: allMarkets = [], isLoading: marketsLoading } = useMarkets();

  // Filter markets for this ticker
  const tickerMarkets = useMemo(
    () =>
      allMarkets
        .filter((m) => m.ticker === ticker)
        .filter((m) => !m.isSettled)
        .sort((a, b) => Number(a.strikePrice) - Number(b.strikePrice)),
    [allMarkets, ticker],
  );

  // Selected market
  const marketParam = searchParams.get("market");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showNewStrike, setShowNewStrike] = useState(false);

  const activeKey = useMemo(() => {
    if (showNewStrike) return null;
    if (selectedKey && tickerMarkets.some((m) => m.publicKey.toBase58() === selectedKey)) {
      return selectedKey;
    }
    if (marketParam && tickerMarkets.some((m) => m.publicKey.toBase58() === marketParam)) {
      return marketParam;
    }
    const strikeParam = searchParams.get("strike");
    if (strikeParam) {
      const strikeLamports = parseFloat(strikeParam) * 1_000_000;
      const match = tickerMarkets.find(
        (m) => Math.abs(Number(m.strikePrice) - strikeLamports) < 1000,
      );
      if (match) return match.publicKey.toBase58();
    }
    return tickerMarkets[0]?.publicKey.toBase58() ?? null;
  }, [selectedKey, showNewStrike, marketParam, searchParams, tickerMarkets]);

  const market = useMemo(
    () => tickerMarkets.find((m) => m.publicKey.toBase58() === activeKey) ?? null,
    [tickerMarkets, activeKey],
  );

  const handleNewStrike = useCallback(() => {
    setShowNewStrike((prev) => !prev);
  }, []);

  // Keyboard shortcuts
  useKeyboardShortcuts({});

  // Loading state
  if (marketsLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="h-20 bg-white/5 rounded-xl border border-white/10 animate-pulse" />
        <div className="h-10 w-64 bg-white/5 rounded animate-pulse" />
        <div className="h-96 bg-white/5 rounded-xl border border-white/10 animate-pulse" />
      </div>
    );
  }

  // No markets and no new-strike mode — show prompt
  if (tickerMarkets.length === 0 && !showNewStrike) {
    return (
      <div className="flex flex-col gap-6">
        <AnalyticsBanner ticker={ticker} market={null} />
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center space-y-4">
          <p className="text-white/50">No active markets for {ticker} today.</p>
          <button
            onClick={() => setShowNewStrike(true)}
            className="bg-accent/20 text-accent border border-accent/30 rounded-lg px-6 py-2.5 text-sm font-semibold hover:bg-accent/30 transition-colors"
          >
            Create First Strike
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Analytics Banner */}
      <AnalyticsBanner ticker={ticker} market={market} />

      {/* My Orders (all strikes) */}
      <MyOrdersPanel ticker={ticker} markets={tickerMarkets} />

      {/* Strike Tabs */}
      <StrikeTabs
        markets={tickerMarkets}
        selectedKey={activeKey}
        onSelect={(key) => {
          setSelectedKey(key);
          setShowNewStrike(false);
        }}
        onNewStrike={handleNewStrike}
        showingNewStrike={showNewStrike}
      />

      {/* New Strike mode */}
      {showNewStrike && (
        <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-8 text-center space-y-3">
          <p className="text-white/50 text-sm">
            Select a strike price for {ticker}. The market will be created when you place your first order.
          </p>
          <p className="text-xs text-white/30">
            Choose a strike from the suggested options or enter a custom price.
          </p>
          {/* TODO: Strike selection UI + connect to OrderTree for the new strike */}
        </div>
      )}

      {/* Order Tree */}
      {market && activeKey && !showNewStrike && (
        <OrderTree
          marketPubkey={market.publicKey}
          altAddress={market.altAddress.equals(PublicKey.default) ? undefined : market.altAddress}
          ticker={ticker}
          strikePrice={Number(market.strikePrice)}
          marketKey={activeKey}
        />
      )}
    </div>
  );
}
