"use client";

import { useMemo, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarkets, type ParsedMarket } from "@/hooks/useMarkets";
import { useMyOrders } from "@/hooks/useMyOrders";
import { useCancelOrder } from "@/hooks/useCancelOrder";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useQuotes } from "@/hooks/useAnalyticsData";
import { generateStrikes } from "@/lib/strikes";
import { OraclePrice } from "@/components/OraclePrice";
import { SettlementStatus } from "@/components/SettlementStatus";
import { SettleButton } from "@/components/SettleButton";
import { OrderTree } from "@/components/OrderTree";
import { PriceHistory } from "@/components/analytics/PriceHistory";
import { HistoricalOverlay } from "@/components/analytics/HistoricalOverlay";
import { BinaryGreeks } from "@/components/BinaryGreeks";
import { getExplorerUrl } from "@/lib/network";

// ---------------------------------------------------------------------------
// Analytics Banner
// ---------------------------------------------------------------------------

function AnalyticsBanner({
  ticker,
  market,
  children,
}: {
  ticker: string;
  market: ParsedMarket | null;
  /** Strike tabs rendered at the bottom of the banner */
  children?: React.ReactNode;
}) {
  const strikeDollars = market ? (Number(market.strikePrice) / 1_000_000).toFixed(0) : null;
  const totalMinted = market ? Number(market.totalMinted) / 1_000_000 : 0;
  const totalRedeemed = market ? Number(market.totalRedeemed) / 1_000_000 : 0;
  const openInterest = totalMinted - totalRedeemed;

  return (
    <div className="relative rounded-xl border border-white/10 overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-r from-green-500/5 via-blue-500/5 to-purple-500/5" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />

      <div className="relative px-5 py-5 space-y-4">
        {/* Main row: ticker+price LEFT, stats+settlement RIGHT */}
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          {/* Left: ticker + price */}
          <div className="flex items-start gap-4">
            <Link
              href="/trade"
              className="text-white/30 hover:text-white/60 transition-colors text-lg mt-2"
            >
              &larr;
            </Link>
            <div>
              <div className="flex items-baseline gap-3 mb-1">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-green-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">{ticker}</h1>
                {strikeDollars && (
                  <span className="text-sm font-mono text-white/30">Strike ${strikeDollars}</span>
                )}
                {market?.isSettled && (
                  <span className="px-2 py-0.5 rounded bg-accent/20 text-accent text-xs font-medium">SETTLED</span>
                )}
              </div>
              <OraclePrice ticker={ticker} />
            </div>
          </div>

          {/* Right: stats + settlement countdown */}
          {market && (
            <div className="flex items-center gap-3 shrink-0">
              <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-2.5 text-center">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Open Interest</p>
                <p className="text-lg font-mono font-bold text-white tabular-nums">{openInterest > 0 ? `$${openInterest.toLocaleString()}` : "—"}</p>
              </div>
              <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-2.5 text-center">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Minted</p>
                <p className="text-lg font-mono font-bold text-white tabular-nums">{totalMinted > 0 ? `$${totalMinted.toLocaleString()}` : "—"}</p>
              </div>
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
          )}
        </div>

        {/* Strike tabs — passed as children, rendered at bottom of banner */}
        {children && (
          <div className="border-t border-white/5 pt-3">
            {children}
          </div>
        )}
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

  if (!publicKey || markets.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white/60">My Orders — {ticker}</h3>
      {markets.map((m) => (
        <MarketOrderRows key={m.publicKey.toBase58()} market={m} />
      ))}
    </div>
  );
}

/** Renders open orders for a single strike market within the My Orders panel. */
function MarketOrderRows({ market }: { market: ParsedMarket }) {
  const marketKey = market.publicKey.toBase58();
  const { orders } = useMyOrders(marketKey);
  const { cancelOrder, cancellingId } = useCancelOrder(marketKey);

  if (orders.length === 0) return null;
  const strikeDollars = (Number(market.strikePrice) / 1_000_000).toFixed(0);

  const sideLabels: Record<number, string> = { 0: "Buy Yes", 1: "Sell Yes", 2: "Sell No" };
  const sideColors: Record<number, string> = {
    0: "text-green-400",
    1: "text-amber-400",
    2: "text-red-400",
  };

  const sideBorders: Record<number, string> = {
    0: "border-green-500/20",
    1: "border-amber-500/20",
    2: "border-red-500/20",
  };

  return (
    <>
      {orders.map((order) => {
        const qty = Number(order.quantity) / 1_000_000;
        const origQty = Number(order.originalQuantity) / 1_000_000;
        const filled = origQty - qty;
        const isCancelling = cancellingId === order.orderId.toString();

        return (
          <div
            key={`${marketKey}-${order.orderId}`}
            className={`inline-flex items-center gap-2 rounded-lg border bg-white/5 px-3 py-1.5 text-sm ${sideBorders[order.side] ?? "border-white/10"}`}
          >
            <span className={`font-semibold ${sideColors[order.side] ?? "text-white/50"}`}>
              {sideLabels[order.side] ?? "?"}
            </span>
            <span className="text-white/60 font-mono">{order.priceLevel}¢</span>
            <span className="text-white/50 font-mono tabular-nums">
              ×{filled > 0 ? `${filled.toFixed(0)}/${origQty.toFixed(0)}` : qty.toFixed(0)}
            </span>
            <button
              onClick={() => cancelOrder(order.orderId, order.priceLevel)}
              disabled={isCancelling}
              className="text-red-400/50 hover:text-red-400 disabled:text-white/20 transition-colors ml-1"
            >
              {isCancelling ? "..." : "✕"}
            </button>
          </div>
        );
      })}
    </>
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
    <div className="space-y-2">
      <span className="text-sm font-semibold text-amber-400">Select Strike</span>
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {markets.map((m) => {
        const strike = (Number(m.strikePrice) / 1_000_000).toFixed(0);
        const key = m.publicKey.toBase58();
        const isSelected = key === selectedKey && !showingNewStrike;

        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`px-4 py-2 rounded-lg text-sm font-mono font-medium transition-all shrink-0 ${
              isSelected
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.15)]"
                : "bg-white/5 text-white/50 border border-white/10 hover:text-white/80 hover:border-white/20"
            }`}
          >
            ${strike}
          </button>
        );
      })}
      <button
        onClick={onNewStrike}
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all shrink-0 ${
          showingNewStrike
            ? "bg-accent/20 text-accent border border-accent/30"
            : "bg-white/5 text-white/50 border border-dashed border-white/20 hover:text-white/80 hover:border-white/30"
        }`}
      >
        + New Strike
      </button>
      </div>
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

  // Filter markets for this ticker — exclude settled AND expired-but-unsettled
  const nowUnix = Math.floor(Date.now() / 1000);
  const tickerMarkets = useMemo(
    () =>
      allMarkets
        .filter((m) => m.ticker === ticker)
        .filter((m) => !m.isSettled && Number(m.marketCloseUnix) > nowUnix)
        .sort((a, b) => Number(a.strikePrice) - Number(b.strikePrice)),
    [allMarkets, ticker, nowUnix],
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

  // New strike selection state
  const [customStrikePrice, setCustomStrikePrice] = useState<number | null>(null);
  const [customStrikeInput, setCustomStrikeInput] = useState("");

  const handleNewStrike = useCallback(() => {
    setShowNewStrike((prev) => !prev);
    setCustomStrikePrice(null);
    setCustomStrikeInput("");
  }, []);

  // Fetch quote for suggested strikes
  const { data: quotes = [] } = useQuotes([ticker]);
  const currentPrice = quotes[0]?.last ?? 0;
  const prevClose = quotes[0]?.prevclose ?? currentPrice;
  const suggestedStrikes = useMemo(() => {
    if (!prevClose || prevClose <= 0) return [];
    return generateStrikes(prevClose).strikes;
  }, [prevClose]);

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
      {/* 1. Analytics Banner — hero with strike tabs inside */}
      <AnalyticsBanner ticker={ticker} market={market}>
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
      </AnalyticsBanner>

      {/* Greeks are passed into OrderTree headerRight below */}

      {/* New Strike mode — strike selection + empty OrderTree */}
      {showNewStrike && (
        <div className="space-y-4">
          <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-5 space-y-4">
            <p className="text-white/50 text-sm text-center">
              Select a strike price. The market will be created when you place your first order.
            </p>

            {/* Suggested strikes */}
            {suggestedStrikes.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-center">
                {suggestedStrikes.map((strike) => {
                  const isAtm = prevClose && Math.abs(strike - prevClose) < (prevClose * 0.035);
                  const isSelected = customStrikePrice === strike && customStrikeInput === "";
                  return (
                    <button
                      key={strike}
                      onClick={() => { setCustomStrikePrice(strike); setCustomStrikeInput(""); }}
                      className={`px-3 py-1.5 rounded-md text-sm font-mono transition-all ${
                        isSelected
                          ? "bg-accent/20 text-accent border border-accent/30"
                          : "bg-white/5 text-white/50 border border-white/10 hover:text-white/80"
                      }`}
                    >
                      ${strike}
                      {isAtm && <span className="ml-1 text-[9px] text-white/30">ATM</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Custom input */}
            <div className="flex items-center gap-2 max-w-xs mx-auto">
              {suggestedStrikes.length > 0 && (
                <span className="text-xs text-white/30 shrink-0">or</span>
              )}
              <input
                type="number"
                step="1"
                min="1"
                value={customStrikeInput}
                onChange={(e) => {
                  setCustomStrikeInput(e.target.value);
                  const val = parseFloat(e.target.value);
                  setCustomStrikePrice(val > 0 ? val : null);
                }}
                placeholder="Custom strike $"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* Empty OrderTree for the new strike — clicking a level triggers creation */}
          {customStrikePrice && (
            <OrderTree
              marketPubkey={null}
              ticker={ticker}
              strikePrice={Math.round(customStrikePrice * 1_000_000)}
              marketKey={null}
              onMarketCreated={(newKey) => {
                setShowNewStrike(false);
                setSelectedKey(newKey);
              }}
            />
          )}
        </div>
      )}

      {/* 4. Order Tree — the action center */}
      {market && activeKey && !showNewStrike && (
        <OrderTree
          marketPubkey={market.publicKey}
          altAddress={market.altAddress.equals(PublicKey.default) ? undefined : market.altAddress}
          ticker={ticker}
          strikePrice={Number(market.strikePrice)}
          marketKey={activeKey}
          headerRight={currentPrice > 0 ? (
            <BinaryGreeks
              spotPrice={currentPrice}
              strikePrice={Number(market.strikePrice) / 1_000_000}
              volatility={0.30}
              timeToExpiry={(() => {
                const now = Math.floor(Date.now() / 1000);
                const close = Number(market.marketCloseUnix);
                const remaining = Math.max(close - now, 60);
                return remaining / (365.25 * 24 * 3600);
              })()}
            />
          ) : undefined}
        />
      )}

      {/* 5. Price History — full width */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-semibold text-white/60 mb-3">{ticker} Price History</h3>
        <PriceHistory ticker={ticker} />
      </div>

      {/* 6. Return Distribution — full width */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-semibold text-white/60 mb-3">{ticker} Return Distribution</h3>
        <HistoricalOverlay
          ticker={ticker}
          currentPrice={currentPrice > 0 ? currentPrice : undefined}
        />
      </div>

      {/* 7. My Orders — bottom */}
      <MyOrdersPanel ticker={ticker} markets={tickerMarkets} />
    </div>
  );
}
