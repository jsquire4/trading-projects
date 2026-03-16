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
  const oracleAgeSecs = feed ? (Date.now() / 1000 - feed.timestamp) : 0;
  const isStale = feed ? oracleAgeSecs > 600 : false;

  // Determine market session from current ET time, not oracle age
  const marketSession = (() => {
    const now = new Date();
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(now);
    const hour = parseInt(etParts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const min = parseInt(etParts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const day = etParts.find((p) => p.type === "weekday")?.value ?? "";
    const etMinutes = hour * 60 + min;
    const isWeekend = day === "Sat" || day === "Sun";

    if (isWeekend) return "closed" as const;
    if (etMinutes >= 570 && etMinutes < 960) return "open" as const;       // 9:30 AM - 4:00 PM
    if (etMinutes >= 240 && etMinutes < 570) return "premarket" as const;  // 4:00 AM - 9:30 AM
    if (etMinutes >= 960 && etMinutes < 1200) return "afterhours" as const; // 4:00 PM - 8:00 PM
    return "closed" as const;
  })();

  const sessionBadge = isStale
    ? { label: "STALE", icon: "⚠️", bg: "bg-yellow-500/15 border-yellow-500/30", text: "text-yellow-400" }
    : marketSession === "open"
    ? { label: "Market Open", icon: "📈", bg: "bg-green-500/10 border-green-500/20", text: "text-green-400" }
    : marketSession === "premarket"
    ? { label: "Pre-Market", icon: "🌅", bg: "bg-orange-500/10 border-orange-500/20", text: "text-orange-300" }
    : marketSession === "afterhours"
    ? { label: "After Hours", icon: "🌙", bg: "bg-indigo-500/10 border-indigo-500/20", text: "text-indigo-300" }
    : { label: "Market Closed", icon: "🔒", bg: "bg-white/5 border-white/10", text: "text-white/40" };

  // Color the price based on direction
  const priceColor = direction === "up"
    ? "text-green-400"
    : direction === "down"
    ? "text-red-400"
    : "text-white";

  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className={`text-3xl font-mono font-bold transition-colors duration-300 ${priceColor}`}>
        ${priceDollars}
      </span>
      <span className={`inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-lg border ${sessionBadge.bg} ${sessionBadge.text}`}>
        <span>{sessionBadge.icon}</span>
        {sessionBadge.label}
      </span>
      {feed && (
        <span className="text-xs text-white/30">
          {new Date(feed.timestamp * 1000).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
