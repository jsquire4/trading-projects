"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { MAG7 } from "@/lib/tickers";

const STORAGE_KEY = "meridian:watchlist";

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

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

/**
 * Manages a persistent watchlist stored in localStorage.
 * Returns the full list of watched tickers (MAG7 defaults + custom).
 */
export function useWatchlist() {
  const [customTickers, setCustomTickers] = useState<string[]>([]);

  // Load from localStorage after mount to avoid SSR hydration mismatch
  useEffect(() => {
    setCustomTickers(loadWatchlist());
  }, []);

  // Sync to localStorage on change (skip initial empty state)
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    saveWatchlist(customTickers);
  }, [customTickers]);

  const addTicker = useCallback((ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper || !TICKER_PATTERN.test(upper)) return;
    setCustomTickers((prev) => {
      // Don't add if already in MAG7 or already custom
      if ((MAG7 as readonly string[]).includes(upper)) return prev;
      if (prev.includes(upper)) return prev;
      return [...prev, upper];
    });
  }, []);

  const removeTicker = useCallback((ticker: string) => {
    setCustomTickers((prev) => prev.filter((t) => t !== ticker));
  }, []);

  // Full watchlist = MAG7 + custom
  const watchlist = [...MAG7, ...customTickers];

  return {
    watchlist,
    customTickers,
    addTicker,
    removeTicker,
  };
}
