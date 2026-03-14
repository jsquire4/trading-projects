// ---------------------------------------------------------------------------
// Synthetic Market Data Client
//
// Drop-in replacement for YahooClient that generates deterministic market
// data using geometric Brownian motion. No external API calls.
//
// Used when MARKET_DATA_SOURCE=synthetic for development/testing when
// markets are closed.
// ---------------------------------------------------------------------------

import type {
  Quote,
  OHLCVBar,
  MarketClock,
  CalendarDay,
  OptionsChainItem,
  IMarketDataClient,
} from "./market-data";

import {
  BASE_PRICES,
  DEFAULT_PRICE,
  DEFAULT_VOL,
  SeededRng,
  hashSeed,
  gbmStep,
  generateBars,
} from "./synthetic-config";

import { binaryCallPrice, normalCdf } from "./pricer";
import { binaryDelta, binaryGamma, binaryTheta, binaryVega } from "./greeks";
import { generateStrikes } from "./strikes";

export interface SyntheticClientOptions {
  seed?: number;
}

export class SyntheticClient implements IMarketDataClient {
  private readonly globalSeed: number;
  /** Per-symbol current prices, evolved via GBM on each getQuotes call. */
  private readonly spotPrices: Map<string, number> = new Map();
  /** Per-symbol RNG instances for deterministic evolution. */
  private readonly rngs: Map<string, SeededRng> = new Map();

  constructor(options: SyntheticClientOptions = {}) {
    this.globalSeed = options.seed ?? 42;
  }

  private getSymbolRng(symbol: string): SeededRng {
    let rng = this.rngs.get(symbol);
    if (!rng) {
      rng = new SeededRng(hashSeed(this.globalSeed, symbol));
      this.rngs.set(symbol, rng);
    }
    return rng;
  }

  private getSpotPrice(symbol: string): number {
    let price = this.spotPrices.get(symbol);
    if (price === undefined) {
      price = BASE_PRICES[symbol] ?? DEFAULT_PRICE;
      this.spotPrices.set(symbol, price);
    }
    return price;
  }

  private evolvePrice(symbol: string): number {
    const rng = this.getSymbolRng(symbol);
    const current = this.getSpotPrice(symbol);
    // 5-second tick: dt = 5 / (252 * 6.5 * 3600) ≈ 8.5e-7 years
    const dt = 5 / (252 * 6.5 * 3600);
    const newPrice = gbmStep(current, rng, DEFAULT_VOL, dt);
    this.spotPrices.set(symbol, newPrice);
    return newPrice;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    return symbols.map((symbol) => {
      const prevclose = BASE_PRICES[symbol] ?? DEFAULT_PRICE;
      const last = this.evolvePrice(symbol);
      const spread = last * 0.001; // 10 bps spread

      return {
        symbol,
        last: Math.round(last * 100) / 100,
        bid: Math.round((last - spread) * 100) / 100,
        ask: Math.round((last + spread) * 100) / 100,
        prevclose,
        volume: Math.floor(1_000_000 + this.getSymbolRng(symbol).next() * 9_000_000),
        change: Math.round((last - prevclose) * 100) / 100,
        change_percentage: Math.round(((last - prevclose) / prevclose) * 10000) / 100,
      };
    });
  }

  async getHistory(
    symbol: string,
    _interval?: string,
    start?: string,
    end?: string,
  ): Promise<OHLCVBar[]> {
    const basePrice = BASE_PRICES[symbol] ?? DEFAULT_PRICE;
    const rng = new SeededRng(hashSeed(this.globalSeed, `history:${symbol}`));

    const numBars = 90;
    const startDate = start ? new Date(start) : undefined;
    const bars = generateBars(basePrice, numBars, rng, startDate);

    // Filter by end date if provided
    if (end) {
      return bars.filter((b) => b.date <= end);
    }
    return bars;
  }

  async getMarketClock(): Promise<MarketClock> {
    const now = new Date();
    return {
      date: now.toISOString().slice(0, 10),
      description: "Synthetic market - always open",
      state: "open",
      timestamp: Math.floor(now.getTime() / 1000),
      next_change: "16:00",
      next_state: "closed",
    };
  }

  async getMarketCalendar(month?: number, year?: number): Promise<CalendarDay[]> {
    const now = new Date();
    const m = month ?? (now.getMonth() + 1);
    const y = year ?? now.getFullYear();

    const days: CalendarDay[] = [];
    const daysInMonth = new Date(y, m, 0).getDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue; // skip weekends

      days.push({
        date: date.toISOString().slice(0, 10),
        status: "open",
        description: "Synthetic trading day",
        premarket: { start: "07:00", end: "09:30" },
        open: { start: "09:30", end: "16:00" },
        postmarket: { start: "16:00", end: "20:00" },
      });
    }

    return days;
  }

  async createStreamSession(): Promise<string> {
    return `synthetic-session-${Date.now()}`;
  }

  async getOptionsChain(
    symbol: string,
    expiration: string,
    greeks?: boolean,
  ): Promise<OptionsChainItem[]> {
    const spot = this.getSpotPrice(symbol);
    const strikes = generateStrikes(spot);

    // Time to expiry in years
    const expiryDate = new Date(expiration + "T16:00:00-05:00");
    const now = new Date();
    const T = Math.max(0, (expiryDate.getTime() - now.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

    const sigma = DEFAULT_VOL;
    const r = 0.05;
    const items: OptionsChainItem[] = [];
    // Per-call deterministic RNG for volume, open_interest, and IV jitter
    const chainRng = new SeededRng(hashSeed(this.globalSeed, `chain:${symbol}:${expiration}`));

    for (const strike of strikes.strikes) {
      for (const optionType of ["call", "put"] as const) {
        const prob = binaryCallPrice(spot, strike, sigma, T, r);
        const callLast = Math.round(prob * 100) / 100;
        const last = optionType === "call" ? callLast : Math.round((1 - prob) * 100) / 100;
        const spread = 0.05;

        const item: OptionsChainItem = {
          symbol: `${symbol}${expiration.replace(/-/g, "")}${optionType === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
          description: `${symbol} ${expiration} ${strike} ${optionType.toUpperCase()}`,
          exch: "SYNTH",
          type: "option",
          last,
          change: null,
          volume: Math.floor(100 + chainRng.next() * 900),
          open: last,
          high: Math.round((last + spread) * 100) / 100,
          low: Math.round(Math.max(0.01, last - spread) * 100) / 100,
          close: last,
          bid: Math.round(Math.max(0.01, last - spread / 2) * 100) / 100,
          ask: Math.round((last + spread / 2) * 100) / 100,
          underlying: symbol,
          strike,
          change_percentage: null,
          average_volume: 500,
          last_volume: 100,
          trade_date: Math.floor(Date.now() / 1000),
          prevclose: last,
          week_52_high: Math.round((last * 1.5) * 100) / 100,
          week_52_low: Math.round((last * 0.5) * 100) / 100,
          bidsize: 10,
          bidexch: "SYNTH",
          bid_date: Math.floor(Date.now() / 1000),
          asksize: 10,
          askexch: "SYNTH",
          ask_date: Math.floor(Date.now() / 1000),
          open_interest: Math.floor(100 + chainRng.next() * 4900),
          contract_size: 100,
          expiration_date: expiration,
          expiration_type: "standard",
          option_type: optionType,
          root_symbol: symbol,
        };

        if (greeks && T > 0) {
          const delta = optionType === "call"
            ? binaryDelta(spot, strike, sigma, T, r)
            : -binaryDelta(spot, strike, sigma, T, r);
          const gamma = binaryGamma(spot, strike, sigma, T, r);
          const theta = binaryTheta(spot, strike, sigma, T, r);
          const vega = binaryVega(spot, strike, sigma, T, r);
          const impliedVol = sigma + (chainRng.next() - 0.5) * 0.02; // small jitter

          item.greeks = {
            delta: Math.round(delta * 10000) / 10000,
            gamma: Math.round(gamma * 10000) / 10000,
            theta: Math.round(theta * 10000) / 10000,
            vega: Math.round(vega * 10000) / 10000,
            rho: 0,
            phi: 0,
            bid_iv: Math.round((impliedVol - 0.01) * 10000) / 10000,
            mid_iv: Math.round(impliedVol * 10000) / 10000,
            ask_iv: Math.round((impliedVol + 0.01) * 10000) / 10000,
            smv_vol: Math.round(sigma * 10000) / 10000,
            updated_at: new Date().toISOString(),
          };
        }

        items.push(item);
      }
    }

    return items;
  }
}
