import { describe, it, expect } from "vitest";
import {
  parseFillEvent,
  parseSettlementEvent,
  type IndexedEvent,
} from "../eventParsers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFillEvent(overrides?: Partial<IndexedEvent>): IndexedEvent {
  return {
    type: "fill",
    data: JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      maker: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      taker: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      price: 65,
      quantity: 1000,
      makerSide: 0,
      takerSide: 1,
      isMerge: false,
      makerOrderId: "42",
      timestamp: 1710100000,
    }),
    signature: "5VERv8NMhKxF6F2Xk4j3y1Kp",
    timestamp: 1710100000,
    ...overrides,
  };
}

/** Build a fill data JSON string with field overrides. */
function makeFillData(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    maker: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    taker: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    price: 65,
    quantity: 1000,
    makerSide: 0,
    takerSide: 1,
    isMerge: false,
    makerOrderId: "42",
    timestamp: 1710100000,
    ...overrides,
  });
}

function makeSettlementEvent(overrides?: Partial<IndexedEvent>): IndexedEvent {
  return {
    type: "settlement",
    data: JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      ticker: "AAPL",
      strikePrice: 15000,
      settlementPrice: 15500,
      outcome: 1,
      timestamp: 1710200000,
    }),
    signature: "3ABCd8NMhKxF6F2Xk4j3y1Kp",
    timestamp: 1710200000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseFillEvent
// ---------------------------------------------------------------------------

describe("parseFillEvent", () => {
  it("returns ParsedFill with all fields for valid fill data", () => {
    const result = parseFillEvent(makeFillEvent());
    expect(result).not.toBeNull();
    expect(result).toEqual({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      maker: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      taker: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      price: 65,
      quantity: 1000,
      makerSide: 0,
      takerSide: 1,
      isMerge: false,
      orderId: "42",
      timestamp: 1710100000,
      signature: "5VERv8NMhKxF6F2Xk4j3y1Kp",
      seq: 0,
    });
  });

  it("returns null for missing/malformed data field", () => {
    const event = makeFillEvent({ data: '{"incomplete": true}' });
    expect(parseFillEvent(event)).toBeNull();
  });

  it("correctly parses maker/taker pubkeys as strings", () => {
    const result = parseFillEvent(makeFillEvent());
    expect(typeof result!.maker).toBe("string");
    expect(typeof result!.taker).toBe("string");
    expect(result!.maker).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(result!.taker).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("correctly parses price, quantity, makerSide, takerSide as numbers", () => {
    const result = parseFillEvent(makeFillEvent());
    expect(typeof result!.price).toBe("number");
    expect(typeof result!.quantity).toBe("number");
    expect(typeof result!.makerSide).toBe("number");
    expect(typeof result!.takerSide).toBe("number");
    expect(result!.price).toBe(65);
    expect(result!.quantity).toBe(1000);
    expect(result!.makerSide).toBe(0);
    expect(result!.takerSide).toBe(1);
  });

  it("handles JSON parse errors gracefully (returns null)", () => {
    const event = makeFillEvent({ data: "not valid json {{{" });
    expect(parseFillEvent(event)).toBeNull();
  });

  it("handles empty string data gracefully (returns null)", () => {
    const event = makeFillEvent({ data: "" });
    expect(parseFillEvent(event)).toBeNull();
  });

  it("returns null when maker is not a string", () => {
    expect(parseFillEvent(makeFillEvent({ data: makeFillData({ maker: 12345 }) }))).toBeNull();
  });

  it("returns null when taker is not a string", () => {
    expect(parseFillEvent(makeFillEvent({ data: makeFillData({ taker: null }) }))).toBeNull();
  });

  it("falls back to event.timestamp when d.timestamp is absent", () => {
    const data = JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      maker: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      taker: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      price: 65,
      quantity: 1000,
      makerSide: 0,
      takerSide: 1,
      isMerge: false,
      makerOrderId: "42",
    });
    const event = makeFillEvent({ data, timestamp: 9999 });
    const result = parseFillEvent(event);
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(9999);
  });

  it("defaults market to empty string when market field is missing", () => {
    const data = JSON.stringify({
      maker: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      taker: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      price: 65,
      quantity: 1000,
      makerSide: 0,
      takerSide: 1,
      isMerge: false,
      makerOrderId: "42",
      timestamp: 1710100000,
    });
    const event = makeFillEvent({ data });
    const result = parseFillEvent(event);
    expect(result).not.toBeNull();
    expect(result!.market).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseSettlementEvent
// ---------------------------------------------------------------------------

describe("parseSettlementEvent", () => {
  it("returns ParsedSettlement with all fields for valid settlement data", () => {
    const result = parseSettlementEvent(makeSettlementEvent());
    expect(result).not.toBeNull();
    expect(result).toEqual({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      ticker: "AAPL",
      strikePrice: 15000,
      settlementPrice: 15500,
      outcome: 1,
      timestamp: 1710200000,
    });
  });

  it("returns null for missing data fields", () => {
    const event = makeSettlementEvent({ data: '{"market": "abc"}' });
    expect(parseSettlementEvent(event)).toBeNull();
  });

  it("correctly parses outcome as number", () => {
    const result = parseSettlementEvent(makeSettlementEvent());
    expect(typeof result!.outcome).toBe("number");
    expect(result!.outcome).toBe(1);
  });

  it("handles JSON parse errors gracefully (returns null)", () => {
    const event = makeSettlementEvent({ data: "{{invalid json}}" });
    expect(parseSettlementEvent(event)).toBeNull();
  });

  it("handles empty string data gracefully (returns null)", () => {
    const event = makeSettlementEvent({ data: "" });
    expect(parseSettlementEvent(event)).toBeNull();
  });

  it("defaults ticker to UNKNOWN when absent", () => {
    const data = JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      strikePrice: 15000,
      settlementPrice: 15500,
      outcome: 1,
      timestamp: 1710200000,
    });
    const result = parseSettlementEvent(makeSettlementEvent({ data }));
    expect(result).not.toBeNull();
    expect(result!.ticker).toBe("UNKNOWN");
  });

  it("defaults market to empty string when absent", () => {
    const data = JSON.stringify({
      ticker: "AAPL",
      strikePrice: 15000,
      settlementPrice: 15500,
      outcome: 1,
      timestamp: 1710200000,
    });
    const result = parseSettlementEvent(makeSettlementEvent({ data }));
    expect(result).not.toBeNull();
    expect(result!.market).toBe("");
  });

  it("returns null when numeric fields are non-numeric strings", () => {
    const data = JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      ticker: "AAPL",
      strikePrice: "not-a-number",
      settlementPrice: 15500,
      outcome: 1,
      timestamp: 1710200000,
    });
    expect(parseSettlementEvent(makeSettlementEvent({ data }))).toBeNull();
  });

  it("falls back to event.timestamp when d.timestamp is absent", () => {
    const data = JSON.stringify({
      market: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      ticker: "AAPL",
      strikePrice: 15000,
      settlementPrice: 15500,
      outcome: 1,
    });
    const result = parseSettlementEvent(makeSettlementEvent({ data, timestamp: 8888 }));
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(8888);
  });
});
