/**
 * Event parser utilities for Meridian on-chain events.
 *
 * The event indexer stores event payloads as JSON strings in the `data` field.
 * These parsers safely decode and validate event data, returning typed objects
 * or null when the data is missing or malformed.
 *
 * Field names match Anchor's JS serialization (camelCase) of the IDL types:
 * - FillEvent:       market, maker, taker, price, quantity, makerSide, takerSide, isMerge, makerOrderId, timestamp
 * - SettlementEvent: market, ticker, strikePrice, settlementPrice, outcome, timestamp
 */

// ---------------------------------------------------------------------------
// Input type — matches the event indexer row shape
// ---------------------------------------------------------------------------

export interface IndexedEvent {
  type: string;
  data: string; // JSON string from event indexer
  timestamp?: number;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Parsed output types
// ---------------------------------------------------------------------------

export interface ParsedFill {
  market: string;
  maker: string;
  taker: string;
  price: number;
  quantity: number;
  makerSide: number;
  takerSide: number;
  isMerge: boolean;
  orderId: string;
  timestamp: number;
  signature: string;
  seq: number;
}

export interface ParsedSettlement {
  market: string;
  ticker: string;
  strikePrice: number;
  settlementPrice: number;
  outcome: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse a FillEvent from the event indexer.
 * Returns null if the data is missing, malformed, or contains NaN values.
 */
export function parseFillEvent(event: IndexedEvent): ParsedFill | null {
  try {
    const d = JSON.parse(event.data);

    const maker = d.maker;
    const taker = d.taker;
    if (typeof maker !== "string" || typeof taker !== "string") return null;

    const price = Number(d.price);
    // Number() safe for quantities under 2^53 (~9B tokens at 6 decimals). BigInt migration deferred.
    const quantity = Number(d.quantity);
    const makerSide = Number(d.makerSide);
    const takerSide = Number(d.takerSide);
    const timestamp = Number(d.timestamp ?? event.timestamp);

    if (
      isNaN(price) ||
      isNaN(quantity) ||
      isNaN(makerSide) ||
      isNaN(takerSide) ||
      isNaN(timestamp)
    ) {
      return null;
    }

    const isMerge = Boolean(d.isMerge);
    const orderId = String(d.makerOrderId ?? "");

    return {
      market: typeof d.market === "string" ? d.market : "",
      maker,
      taker,
      price,
      quantity,
      makerSide,
      takerSide,
      isMerge,
      orderId,
      timestamp,
      signature: event.signature ?? "",
      seq: Number(d.seq ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Parse a SettlementEvent from the event indexer.
 * Returns null if the data is missing, malformed, or contains NaN values.
 */
export function parseSettlementEvent(
  event: IndexedEvent,
): ParsedSettlement | null {
  try {
    const d = JSON.parse(event.data);

    const strikePrice = Number(d.strikePrice);
    const settlementPrice = Number(d.settlementPrice);
    const outcome = Number(d.outcome);
    const timestamp = Number(d.timestamp ?? event.timestamp);

    if (
      isNaN(strikePrice) ||
      isNaN(settlementPrice) ||
      isNaN(outcome) ||
      isNaN(timestamp)
    ) {
      return null;
    }

    return {
      market: d.market ?? "",
      ticker: d.ticker ?? "UNKNOWN",
      strikePrice,
      settlementPrice,
      outcome,
      timestamp,
    };
  } catch {
    return null;
  }
}
