"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOrderBook } from "./useMarkets";
import type { ActiveOrder } from "@/lib/orderbook";

export interface MyOrder extends ActiveOrder {
  marketKey: string;
}

export function useMyOrders(marketKey: string | null) {
  const { publicKey } = useWallet();
  const { data: book, isLoading } = useOrderBook(marketKey);

  const orders = useMemo(() => {
    if (!book || !publicKey || !marketKey) return [];

    return book.raw.orders
      .filter((order) => order.owner.equals(publicKey))
      .map((order) => ({ ...order, marketKey }));
  }, [book, publicKey, marketKey]);

  return { orders, isLoading };
}
