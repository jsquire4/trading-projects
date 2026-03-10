"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { findPriceFeed } from "@/lib/pda";

interface PriceFeedData {
  ticker: string;
  price: number; // raw u64 lamports
  confidence: number;
  timestamp: number;
}

interface OraclePriceProps {
  ticker: string;
}

function parsePriceFeed(data: Buffer): PriceFeedData | null {
  // Layout (after 8-byte Anchor discriminator):
  // ticker: [u8; 8] at offset 8
  // price: u64 at offset 16
  // confidence: u64 at offset 24
  // timestamp: i64 at offset 32
  // authority: Pubkey at offset 40
  // is_initialized: bool at offset 72

  if (data.length < 73) return null;

  const tickerBytes = data.subarray(8, 16);
  const nullIdx = tickerBytes.indexOf(0);
  const ticker = tickerBytes.subarray(0, nullIdx === -1 ? 8 : nullIdx).toString("utf-8");

  const price = Number(data.readBigUInt64LE(16));
  const confidence = Number(data.readBigUInt64LE(24));
  const timestamp = Number(data.readBigInt64LE(32));

  return { ticker, price, confidence, timestamp };
}

export function OraclePrice({ ticker }: OraclePriceProps) {
  const { connection } = useConnection();
  const [feed, setFeed] = useState<PriceFeedData | null>(null);
  const [direction, setDirection] = useState<"up" | "down" | null>(null);
  const prevPrice = useRef<number | null>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAccountChange = useCallback((accountInfo: { data: Buffer }) => {
    const parsed = parsePriceFeed(accountInfo.data);
    if (!parsed) return;

    if (prevPrice.current !== null) {
      if (parsed.price > prevPrice.current) setDirection("up");
      else if (parsed.price < prevPrice.current) setDirection("down");
    }
    prevPrice.current = parsed.price;
    setFeed(parsed);

    // Clear flash after 600ms
    if (flashTimeout.current) clearTimeout(flashTimeout.current);
    flashTimeout.current = setTimeout(() => setDirection(null), 600);
  }, []);

  useEffect(() => {
    const [feedAddress] = findPriceFeed(ticker);
    let subId: number | undefined;
    let cancelled = false;

    // Fetch initial value
    connection.getAccountInfo(feedAddress).then((info) => {
      if (cancelled) return;
      if (info) {
        const parsed = parsePriceFeed(info.data as Buffer);
        if (parsed) {
          prevPrice.current = parsed.price;
          setFeed(parsed);
        }
      }
    });

    // Subscribe to changes
    subId = connection.onAccountChange(feedAddress, handleAccountChange, "confirmed");

    return () => {
      cancelled = true;
      if (subId !== undefined) {
        connection.removeAccountChangeListener(subId);
      }
      if (flashTimeout.current) clearTimeout(flashTimeout.current);
    };
  }, [connection, ticker, handleAccountChange]);

  const priceDollars = feed ? (feed.price / 1_000_000).toFixed(2) : "--";
  const confidenceDollars = feed ? (feed.confidence / 1_000_000).toFixed(4) : null;
  const isStale = feed ? (Date.now() / 1000 - feed.timestamp) > 60 : false;

  const flashClass =
    direction === "up"
      ? "text-yes transition-colors duration-300"
      : direction === "down"
        ? "text-no transition-colors duration-300"
        : "text-white transition-colors duration-300";

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">{ticker}</span>
      <span className={`text-lg font-mono font-bold ${flashClass}`}>
        ${priceDollars}
      </span>
      {confidenceDollars && (
        <span className="text-[10px] text-white/30" title="Oracle confidence interval">
          +/-${confidenceDollars}
        </span>
      )}
      {isStale && (
        <span className="text-[10px] font-medium text-yellow-400" title="Oracle price is stale (>60s old)">
          STALE
        </span>
      )}
      {feed && (
        <span className={`text-[10px] ${isStale ? "text-yellow-400/50" : "text-white/30"}`}>
          {new Date(feed.timestamp * 1000).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
