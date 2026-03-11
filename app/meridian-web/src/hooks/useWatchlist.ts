"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { MAG7 } from "@/lib/tickers";

const STORAGE_KEY = "meridian:watchlist";
const TICKER_PATTERN = /^[A-Z]{1,10}$/;

interface WatchlistStorage {
  version: 1;
  customTickers: string[];
}

function loadWatchlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: WatchlistStorage = JSON.parse(raw);
    if (parsed.version !== 1) return [];
    return parsed.customTickers;
  } catch {
    return [];
  }
}

function saveWatchlist(customTickers: string[]): void {
  const data: WatchlistStorage = { version: 1, customTickers };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Module-level shared state so all useWatchlist() instances stay in sync
// ---------------------------------------------------------------------------

type Listener = (tickers: string[]) => void;
const listeners = new Set<Listener>();
let sharedTickers: string[] | null = null;

function getSharedTickers(): string[] {
  if (sharedTickers === null) {
    sharedTickers = loadWatchlist();
  }
  return sharedTickers;
}

function setSharedTickers(tickers: string[]): void {
  sharedTickers = tickers;
  saveWatchlist(tickers);
  for (const fn of listeners) fn(tickers);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages a persistent watchlist stored in localStorage.
 * All instances share state via module-level sync — adding a ticker
 * in one component updates all others immediately.
 */
export function useWatchlist() {
  const [customTickers, setCustomTickers] = useState<string[]>([]);

  // Load shared state after mount (SSR-safe)
  useEffect(() => {
    setCustomTickers(getSharedTickers());

    const listener: Listener = (tickers) => setCustomTickers(tickers);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const addTicker = useCallback((ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper || !TICKER_PATTERN.test(upper)) return;
    if ((MAG7 as readonly string[]).includes(upper)) return;

    const current = getSharedTickers();
    if (current.includes(upper)) return;
    setSharedTickers([...current, upper]);
  }, []);

  const removeTicker = useCallback((ticker: string) => {
    const current = getSharedTickers();
    setSharedTickers(current.filter((t) => t !== ticker));
  }, []);

  const watchlist = [...MAG7, ...customTickers];

  return {
    watchlist,
    customTickers,
    addTicker,
    removeTicker,
  };
}
