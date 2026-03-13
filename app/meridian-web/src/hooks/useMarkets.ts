"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAnchorProgram } from "./useAnchorProgram";
import {
  deserializeOrderBook,
  buildYesView,
  buildNoView,
  type DeserializedOrderBook,
  type OrderBookView,
} from "@/lib/orderbook";
import { findOrderBook } from "@/lib/pda";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedMarket {
  publicKey: PublicKey;
  config: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
  strikePrice: bigint;
  marketCloseUnix: bigint;
  totalMinted: bigint;
  totalRedeemed: bigint;
  settlementPrice: bigint;
  previousClose: bigint;
  settledAt: bigint;
  overrideDeadline: bigint;
  altAddress: PublicKey;
  ticker: string;
  isSettled: boolean;
  outcome: number;
  isPaused: boolean;
  isClosed: boolean;
  overrideCount: number;
  bump: number;
}

export interface OrderBookData {
  raw: DeserializedOrderBook;
  yesView: OrderBookView;
  noView: OrderBookView;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw StrikeMarket account into a typed object.
 * Anchor's coder already does most of the work; we just normalize types.
 */
function parseMarketAccount(
  publicKey: PublicKey,
  account: unknown,
): ParsedMarket {
  const a = account as Record<string, unknown>;

  // Ticker is stored as a u8[8] array — decode to trimmed string
  const tickerBytes = a.ticker as number[];
  const ticker = Buffer.from(tickerBytes)
    .toString("utf-8")
    .replace(/\0+$/, "");

  return {
    publicKey,
    config: a.config as PublicKey,
    yesMint: a.yesMint as PublicKey,
    noMint: a.noMint as PublicKey,
    usdcVault: a.usdcVault as PublicKey,
    escrowVault: a.escrowVault as PublicKey,
    yesEscrow: a.yesEscrow as PublicKey,
    noEscrow: a.noEscrow as PublicKey,
    orderBook: a.orderBook as PublicKey,
    oracleFeed: a.oracleFeed as PublicKey,
    strikePrice: BigInt((a.strikePrice ?? 0).toString()),
    marketCloseUnix: BigInt((a.marketCloseUnix ?? 0).toString()),
    totalMinted: BigInt((a.totalMinted ?? 0).toString()),
    totalRedeemed: BigInt((a.totalRedeemed ?? 0).toString()),
    settlementPrice: BigInt((a.settlementPrice ?? 0).toString()),
    previousClose: BigInt((a.previousClose ?? 0).toString()),
    settledAt: BigInt((a.settledAt ?? 0).toString()),
    overrideDeadline: BigInt((a.overrideDeadline ?? 0).toString()),
    altAddress: a.altAddress as PublicKey,
    ticker,
    isSettled: a.isSettled as boolean,
    outcome: a.outcome as number,
    isPaused: a.isPaused as boolean,
    isClosed: a.isClosed as boolean,
    overrideCount: a.overrideCount as number,
    bump: a.bump as number,
  };
}

// ---------------------------------------------------------------------------
// useMarkets — all StrikeMarket accounts
// ---------------------------------------------------------------------------

/**
 * Fetches all StrikeMarket accounts with 10s polling.
 */
export function useMarkets() {
  const { program } = useAnchorProgram();

  return useQuery<ParsedMarket[]>({
    queryKey: ["markets"],
    queryFn: async () => {
      if (!program) return [];

      const accounts = await program.account.strikeMarket.all();
      return accounts.map((a) =>
        parseMarketAccount(a.publicKey, a.account),
      );
    },
    enabled: !!program,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// ---------------------------------------------------------------------------
// useMarket — single StrikeMarket
// ---------------------------------------------------------------------------

/**
 * Fetches a single StrikeMarket account by public key.
 */
export function useMarket(marketKey: PublicKey | string | null) {
  const { program } = useAnchorProgram();

  const key = useMemo(() => {
    if (!marketKey) return null;
    return typeof marketKey === "string" ? new PublicKey(marketKey) : marketKey;
  }, [marketKey]);

  return useQuery<ParsedMarket | null>({
    queryKey: ["market", key?.toBase58() ?? null],
    queryFn: async () => {
      if (!program || !key) return null;

      const account = await program.account.strikeMarket.fetch(key);
      return parseMarketAccount(key, account);
    },
    enabled: !!program && !!key,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// ---------------------------------------------------------------------------
// useOrderBook — raw + deserialized order book for a market
// ---------------------------------------------------------------------------

/**
 * Fetches the raw OrderBook account data and deserializes it using the
 * custom DataView-based deserializer. Returns both Yes and No perspectives.
 *
 * Polls every 5 seconds for near-real-time order book updates.
 */
/**
 * Batch-fetch orderbooks for multiple markets in a single RPC call.
 * Uses getMultipleAccountsInfo instead of N individual getAccountInfo calls.
 */
export function useOrderBooks(marketKeys: (PublicKey | string)[]) {
  const { connection } = useConnection();

  // Stabilize addresses — marketKeys array identity changes every render
  const marketKeysStr = useMemo(
    () => marketKeys.map((k) => (typeof k === "string" ? k : k.toBase58())).sort().join(","),
    [marketKeys],
  );
  const addresses = useMemo(() => {
    return marketKeys.map((k) => {
      const pk = typeof k === "string" ? new PublicKey(k) : k;
      const [addr] = findOrderBook(pk);
      return addr;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKeysStr]);

  return useQuery<Map<string, OrderBookData>>({
    queryKey: [
      "orderbooks-batch",
      addresses.map((a) => a.toBase58()).sort().join(","),
    ],
    queryFn: async () => {
      if (addresses.length === 0) return new Map();

      const accounts = await connection.getMultipleAccountsInfo(
        addresses,
        "confirmed",
      );
      const result = new Map<string, OrderBookData>();

      for (let i = 0; i < marketKeys.length; i++) {
        const acct = accounts[i];
        if (!acct) continue;
        const key =
          typeof marketKeys[i] === "string"
            ? (marketKeys[i] as string)
            : (marketKeys[i] as PublicKey).toBase58();
        const raw = deserializeOrderBook(Buffer.from(acct.data));
        result.set(key, {
          raw,
          yesView: buildYesView(raw.orders),
          noView: buildNoView(raw.orders),
        });
      }

      return result;
    },
    enabled: addresses.length > 0,
    refetchInterval: 5_000,
    staleTime: 2_500,
  });
}

// ---------------------------------------------------------------------------
// useOrderBook — raw + deserialized order book for a single market
// ---------------------------------------------------------------------------

export function useOrderBook(marketKey: PublicKey | string | null) {
  const { connection } = useConnection();

  const key = useMemo(() => {
    if (!marketKey) return null;
    return typeof marketKey === "string" ? new PublicKey(marketKey) : marketKey;
  }, [marketKey]);

  const orderBookAddress = useMemo(() => {
    if (!key) return null;
    const [addr] = findOrderBook(key);
    return addr;
  }, [key]);

  return useQuery<OrderBookData | null>({
    queryKey: ["orderbook", orderBookAddress?.toBase58() ?? null],
    queryFn: async () => {
      if (!orderBookAddress) return null;

      const accountInfo = await connection.getAccountInfo(
        orderBookAddress,
        "confirmed",
      );

      if (!accountInfo) return null;

      const raw = deserializeOrderBook(
        Buffer.from(accountInfo.data),
      );
      const yesView = buildYesView(raw.orders);
      const noView = buildNoView(raw.orders);

      return { raw, yesView, noView };
    },
    enabled: !!orderBookAddress,
    refetchInterval: 5_000,
    staleTime: 2_500,
  });
}
