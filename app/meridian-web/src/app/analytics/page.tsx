"use client";

import { Component, type ReactNode, useState } from "react";
import { useMarkets } from "@/hooks/useMarkets";
import { OptionsComparison } from "@/components/analytics/OptionsComparison";
import { HistoricalOverlay } from "@/components/analytics/HistoricalOverlay";
import { SettlementAnalytics } from "@/components/analytics/SettlementAnalytics";
import { GreeksDisplay } from "@/components/analytics/GreeksDisplay";
import { useTradierQuotes } from "@/hooks/useAnalyticsData";

const TICKERS = ["AAPL", "TSLA", "AMZN", "MSFT", "NVDA", "GOOGL", "META"];

// Simple error boundary to isolate component failures
class AnalyticsErrorBoundary extends Component<
  { title: string; children: ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { title: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="text-sm text-red-400/70">
          {this.props.title} failed to load: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AnalyticsPage() {
  const [selectedTicker, setSelectedTicker] = useState(TICKERS[0]);
  const { data: markets } = useMarkets();
  const { data: quotes, isLoading: quotesLoading } = useTradierQuotes(TICKERS);

  const tickerMarkets = (markets ?? []).filter(
    (m) => m.ticker.toUpperCase() === selectedTicker.toUpperCase(),
  );
  const currentQuote = quotes?.find(
    (q) => q.symbol.toUpperCase() === selectedTicker.toUpperCase(),
  );
  const currentPrice = currentQuote?.last ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <div className="flex gap-2">
          {TICKERS.map((t) => (
            <button
              key={t}
              onClick={() => setSelectedTicker(t)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                t === selectedTicker
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/70"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {quotesLoading ? (
        <p className="text-white/30 text-sm">Loading quote data...</p>
      ) : currentPrice > 0 ? (
        <p className="text-white/50 text-sm">
          {selectedTicker} current price: ${currentPrice.toFixed(2)}
        </p>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white/5 rounded-xl p-6 border border-white/10">
          <h2 className="text-lg font-semibold mb-4">Binary Greeks</h2>
          <AnalyticsErrorBoundary title="Binary Greeks">
            <GreeksDisplay ticker={selectedTicker} markets={tickerMarkets} />
          </AnalyticsErrorBoundary>
        </div>

        <div className="bg-white/5 rounded-xl p-6 border border-white/10">
          <h2 className="text-lg font-semibold mb-4">Options Comparison</h2>
          <AnalyticsErrorBoundary title="Options Comparison">
            <OptionsComparison ticker={selectedTicker} markets={tickerMarkets} />
          </AnalyticsErrorBoundary>
        </div>

        <div className="bg-white/5 rounded-xl p-6 border border-white/10">
          <h2 className="text-lg font-semibold mb-4">Historical Distribution</h2>
          <AnalyticsErrorBoundary title="Historical Distribution">
            <HistoricalOverlay
              ticker={selectedTicker}
              markets={tickerMarkets}
              currentPrice={currentPrice > 0 ? currentPrice : undefined}
            />
          </AnalyticsErrorBoundary>
        </div>

        <div className="bg-white/5 rounded-xl p-6 border border-white/10">
          <h2 className="text-lg font-semibold mb-4">Settlement History</h2>
          <AnalyticsErrorBoundary title="Settlement Analytics">
            <SettlementAnalytics />
          </AnalyticsErrorBoundary>
        </div>
      </div>
    </div>
  );
}
