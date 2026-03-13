"use client";

import { useMemo, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { usePositions } from "@/hooks/usePositions";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { OrderBook } from "@/components/OrderBook";
import { OrderForm } from "@/components/OrderForm";
import { OraclePrice } from "@/components/OraclePrice";
import { SettlementStatus } from "@/components/SettlementStatus";
import { SettleButton } from "@/components/SettleButton";
import { MarketInfo } from "@/components/MarketInfo";
import { MyOrders } from "@/components/MyOrders";
import { MyPositions } from "@/components/MyPositions";
import { RedeemPanel } from "@/components/RedeemPanel";
import { FillFeed } from "@/components/FillFeed";
import { PayoffDisplay } from "@/components/PayoffDisplay";
import { getExplorerUrl } from "@/lib/network";

// ---------------------------------------------------------------------------
// Strike selector
// ---------------------------------------------------------------------------

function StrikeSelector({
  markets,
  selectedKey,
  onSelect,
}: {
  markets: ParsedMarket[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  if (markets.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <span className="text-xs text-white/40 shrink-0">Strike:</span>
      {markets.map((m) => {
        const strike = (Number(m.strikePrice) / 1_000_000).toFixed(0);
        const key = m.publicKey.toBase58();
        const isSelected = key === selectedKey;

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
  const { data: positions = [] } = usePositions();

  // Filter markets for this ticker
  const tickerMarkets = useMemo(
    () =>
      allMarkets
        .filter((m) => m.ticker === ticker && !m.isClosed)
        .sort(
          (a, b) => Number(a.strikePrice) - Number(b.strikePrice),
        ),
    [allMarkets, ticker],
  );

  // Selected market
  const marketParam = searchParams.get("market");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const activeKey = useMemo(() => {
    if (selectedKey && tickerMarkets.some((m) => m.publicKey.toBase58() === selectedKey)) {
      return selectedKey;
    }
    if (marketParam && tickerMarkets.some((m) => m.publicKey.toBase58() === marketParam)) {
      return marketParam;
    }
    // Match by strike from query param
    const strikeParam = searchParams.get("strike");
    if (strikeParam) {
      const strikeLamports = parseFloat(strikeParam) * 1_000_000;
      const match = tickerMarkets.find(
        (m) => Math.abs(Number(m.strikePrice) - strikeLamports) < 1000,
      );
      if (match) return match.publicKey.toBase58();
    }
    return tickerMarkets[0]?.publicKey.toBase58() ?? null;
  }, [selectedKey, marketParam, searchParams, tickerMarkets]);

  const market = useMemo(
    () => tickerMarkets.find((m) => m.publicKey.toBase58() === activeKey) ?? null,
    [tickerMarkets, activeKey],
  );

  // Position for this market
  const position = useMemo(
    () => positions.find((p) => p.market.publicKey.toBase58() === activeKey) ?? null,
    [positions, activeKey],
  );

  // Price click from OrderBook fills the OrderForm price
  const [clickedPrice, setClickedPrice] = useState<number | null>(null);
  const handlePriceClick = useCallback((price: number) => {
    setClickedPrice(price);
  }, []);

  // Transaction receipt state (H4)
  const [lastTxSignature, setLastTxSignature] = useState<string | null>(null);
  const handleTransactionSuccess = useCallback((sig: string) => {
    setLastTxSignature(sig);
  }, []);

  // Mobile section toggles
  const [showOrderBook, setShowOrderBook] = useState(true);
  const [showMyOrders, setShowMyOrders] = useState(true);

  // Keyboard shortcuts
  useKeyboardShortcuts({});

  // Loading state
  if (marketsLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="h-8 w-48 bg-white/10 rounded animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-5 space-y-4">
            <div className="h-64 bg-white/5 rounded-lg border border-white/10 animate-pulse" />
            <div className="h-32 bg-white/5 rounded-lg border border-white/10 animate-pulse" />
          </div>
          <div className="lg:col-span-4 space-y-4">
            <div className="h-64 bg-white/5 rounded-lg border border-white/10 animate-pulse" />
          </div>
          <div className="lg:col-span-3 space-y-4">
            <div className="h-32 bg-white/5 rounded-lg border border-white/10 animate-pulse" />
            <div className="h-32 bg-white/5 rounded-lg border border-white/10 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  // No markets for this ticker
  if (tickerMarkets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <h1 className="text-2xl font-bold text-white">{ticker}</h1>
        <p className="text-white/50">No active markets for {ticker} today.</p>
        <Link
          href="/trade"
          className="text-sm text-accent hover:text-accent/80 transition-colors"
        >
          &larr; Back to all markets
        </Link>
      </div>
    );
  }

  if (!market || !activeKey) {
    return null;
  }

  const strikeDollars = Number(market.strikePrice) / 1_000_000;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
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
              <h1 className="text-xl font-bold text-white">
                {ticker} &mdash; ${strikeDollars.toFixed(0)}
              </h1>
              {market.isPaused && (
                <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-medium">
                  PAUSED
                </span>
              )}
              {market.isSettled && (
                <span className="px-2 py-0.5 rounded bg-accent/20 text-accent text-[10px] font-medium">
                  SETTLED
                </span>
              )}
            </div>
            <OraclePrice ticker={ticker} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SettlementStatus
            marketCloseUnix={Number(market.marketCloseUnix)}
            isSettled={market.isSettled}
            outcome={market.outcome}
            overrideDeadline={Number(market.overrideDeadline)}
            settlementPrice={Number(market.settlementPrice)}
            strikePrice={Number(market.strikePrice)}
          />
          <SettleButton market={market} />
        </div>
      </div>

      {/* Strike selector */}
      <StrikeSelector
        markets={tickerMarkets}
        selectedKey={activeKey}
        onSelect={setSelectedKey}
      />

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left column — Order Book + Market Info */}
        <div className="lg:col-span-5 space-y-4">
          {/* Mobile toggle */}
          <button
            onClick={() => setShowOrderBook(!showOrderBook)}
            className="lg:hidden flex items-center justify-between w-full text-sm text-white/60 py-2"
          >
            <span>Order Book</span>
            <span>{showOrderBook ? "\u25BE" : "\u25B8"}</span>
          </button>
          {showOrderBook && (
            <OrderBook
              perspective="yes"
              marketKey={activeKey}
              onPriceClick={handlePriceClick}
            />
          )}
          <MarketInfo market={market} />
        </div>

        {/* Center column — Order Form + Redeem */}
        <div className="lg:col-span-4 space-y-4">
          <OrderForm
            marketKey={activeKey}
            ticker={ticker}
            strikePrice={Number(market.strikePrice)}
            initialPrice={clickedPrice}
            onTransactionSuccess={handleTransactionSuccess}
          />

          {/* Transaction receipt after successful order */}
          {lastTxSignature && (
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-xs">✓</div>
                  <span className="text-sm font-semibold text-green-400">Order Submitted</span>
                </div>
                <button onClick={() => setLastTxSignature(null)} className="text-white/30 hover:text-white/60 text-sm">✕</button>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={getExplorerUrl(lastTxSignature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center text-xs text-accent hover:text-accent/80 py-1.5 rounded-md border border-white/10 hover:border-white/20"
                >
                  View on Explorer
                </a>
              </div>
              <p className="text-[10px] text-white/20 text-center font-mono truncate">{lastTxSignature}</p>
            </div>
          )}

          {/* Payoff explainer */}
          <PayoffDisplay
            side={position && position.noBal > position.yesBal ? "no" : "yes"}
            price={clickedPrice ?? 50}
            ticker={ticker}
            strikePrice={Number(market.strikePrice)}
          />

          {/* Redeem panel — show when user can pair-burn (holds both tokens) or market is settled */}
          {(market.isSettled || (position && position.yesBal > BigInt(0) && position.noBal > BigInt(0))) && (
            <RedeemPanel
              market={market}
              yesBal={position?.yesBal ?? BigInt(0)}
              noBal={position?.noBal ?? BigInt(0)}
            />
          )}
        </div>

        {/* Right column — My Orders + My Positions + Fill Feed */}
        <div className="lg:col-span-3 space-y-4">
          {/* Mobile toggle */}
          <button
            onClick={() => setShowMyOrders(!showMyOrders)}
            className="lg:hidden flex items-center justify-between w-full text-sm text-white/60 py-2"
          >
            <span>Orders &amp; Positions</span>
            <span>{showMyOrders ? "\u25BE" : "\u25B8"}</span>
          </button>
          {showMyOrders && (
            <>
              <MyOrders marketKey={activeKey} />
              <MyPositions marketKey={activeKey} />
            </>
          )}
          <FillFeed marketKey={activeKey} />
        </div>
      </div>
    </div>
  );
}
