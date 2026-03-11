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
  totalMinted: number;
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

      // Batch fetch order books using getMultipleAccountsInfo (single RPC call per batch)
      const batchSize = 100; // getMultipleAccountsInfo supports up to 100
      for (let i = 0; i < activeMarkets.length; i += batchSize) {
        const batch = activeMarkets.slice(i, i + batchSize);
        const orderBookAddrs = batch.map((m) => findOrderBook(m.publicKey)[0]);

        const accountInfos = await connection.getMultipleAccountsInfo(orderBookAddrs, "confirmed");

        for (let j = 0; j < batch.length; j++) {
          const market = batch[j];
          const accountInfo = accountInfos[j];

          let bestBid: number | null = null;
          let bestAsk: number | null = null;
          let spread: number | null = null;

          if (accountInfo) {
            try {
              const raw = deserializeOrderBook(Buffer.from(accountInfo.data));
              const yesView = buildYesView(raw.orders);
              bestBid = yesView.bestBid;
              bestAsk = yesView.bestAsk;
              spread = yesView.spread;
            } catch {
              // Malformed order book data — leave bid/ask/spread as null
            }
          }

          summaries.push({
            marketKey: market.publicKey.toBase58(),
            ticker: market.ticker,
            strike: Number(market.strikePrice) / 1_000_000,
            bestBid,
            bestAsk,
            spread,
            totalMinted: Number(market.totalMinted) / 1_000_000,
            openInterest: Math.max(0, (Number(market.totalMinted) - Number(market.totalRedeemed)) / 1_000_000),
          });
        }
      }

      return summaries;
    },
    enabled: activeMarkets.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
