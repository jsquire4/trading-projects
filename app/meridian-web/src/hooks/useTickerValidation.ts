"use client";

import { useState, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ValidationStatus = "idle" | "loading" | "error";

interface UseTickerValidationReturn {
  status: ValidationStatus;
  errorMsg: string;
  /** Validate a ticker symbol via the market-data quotes API. Returns true if valid. */
  validate: (ticker: string) => Promise<boolean>;
  /** Clear error state back to idle. */
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Shared ticker validation logic for WatchlistStrip's AddTickerInput and
 * the analytics page's TickerSearch. Calls /api/market-data/quotes and
 * checks that the returned quote has a positive `last` price.
 */
export function useTickerValidation(): UseTickerValidationReturn {
  const [status, setStatus] = useState<ValidationStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const validatingRef = useRef(false);

  const clearError = useCallback(() => {
    setStatus("idle");
    setErrorMsg("");
  }, []);

  const validate = useCallback(async (ticker: string): Promise<boolean> => {
    const upper = ticker.trim().toUpperCase();
    if (!upper || validatingRef.current) return false;

    validatingRef.current = true;
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch(
        `/api/market-data/quotes?symbols=${encodeURIComponent(upper)}`,
      );
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(`Request failed (${res.status})`);
        return false;
      }
      const data: unknown = await res.json();
      const quotes = (Array.isArray(data) ? data : []) as Array<{
        symbol?: string;
        last?: number;
      }>;
      const valid =
        quotes.length > 0 &&
        typeof quotes[0]?.last === "number" &&
        quotes[0].last > 0;

      if (valid) {
        setStatus("idle");
        return true;
      }

      setStatus("error");
      setErrorMsg(`"${upper}" not found or not tradeable`);
      return false;
    } catch (err) {
      setStatus("error");
      setErrorMsg("Validation failed — check connection");
      console.error("Ticker validation error:", err);
      return false;
    } finally {
      validatingRef.current = false;
    }
  }, []);

  return { status, errorMsg, validate, clearError };
}
