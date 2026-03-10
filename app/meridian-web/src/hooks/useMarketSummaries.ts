"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { useMarkets, type ParsedMarket } from "./useMarkets";
import { findOrderBook } from "@/lib/pda";
import { deserializeOrderBook, buildYesView } from "@/lib/orderbook";

export interface MarketSummary {
  marketKey: string;
  ticker: string;
  strike: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume: number;
  openInterest: number;
}

export function useMarketSummaries() {
  const { data: markets = [] } = useMarkets();
  const { connection } = useConnection();

  const activeMarkets = useMemo(
    () => markets.filter((m) => !m.isSettled && !m.isClosed),
    [markets],
  );

  return useQuery<MarketSummary[]>({
    queryKey: ["market-summaries", activeMarkets.map((m) => m.publicKey.toBase58()).join(",")],
    queryFn: async () => {
      if (activeMarkets.length === 0) return [];

      const summaries: MarketSummary[] = [];

      // Fetch order books in parallel (max 10 at a time to avoid rate limits)
      const batchSize = 10;
      for (let i = 0; i < activeMarkets.length; i += batchSize) {
        const batch = activeMarkets.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (market) => {
            const [orderBookAddr] = findOrderBook(market.publicKey);
            const accountInfo = await connection.getAccountInfo(orderBookAddr, "confirmed");

            let bestBid: number | null = null;
            let bestAsk: number | null = null;
            let spread: number | null = null;

            if (accountInfo) {
              const raw = deserializeOrderBook(Buffer.from(accountInfo.data));
              const yesView = buildYesView(raw.orders);
              bestBid = yesView.bestBid;
              bestAsk = yesView.bestAsk;
              spread = yesView.spread;
            }

            return {
              marketKey: market.publicKey.toBase58(),
              ticker: market.ticker,
              strike: Number(market.strikePrice) / 1_000_000,
              bestBid,
              bestAsk,
              spread,
              volume: Number(market.totalMinted) / 1_000_000,
              openInterest: Math.max(0, (Number(market.totalMinted) - Number(market.totalRedeemed)) / 1_000_000),
            };
          }),
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            summaries.push(result.value);
          }
        }
      }

      return summaries;
    },
    enabled: activeMarkets.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
