import { describe, it, expect, vi } from "vitest";
import { parseEventsFromLogs, type ParsedEvent } from "../listener.js";

/**
 * The real BorshCoder requires a valid Anchor IDL and decodes base64-encoded
 * borsh data. For unit testing the log-parsing logic we create a mock coder
 * that lets us control what `coder.events.decode()` returns.
 */
function makeMockCoder(decodeFn: (data: string) => any) {
  return {
    events: {
      decode: decodeFn,
    },
  } as any; // cast to satisfy BorshCoder shape
}

const PROGRAM_ID = "MERDNhq1LZLG4GHitHeXBEb3iJTibqZELd1thxYxR3p";

describe("parseEventsFromLogs", () => {
  // ---- Basic parsing ----

  it("parses a FillEvent from well-formed logs", () => {
    const coder = makeMockCoder((data: string) => {
      if (data === "AQIDBA==") {
        return {
          name: "FillEvent",
          data: {
            market: "MarketABC",
            timestamp: 1700000000,
            price: 50,
          },
        };
      }
      return null;
    });

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program log: Instruction: PlaceOrder`,
      `Program data: AQIDBA==`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("fill");
    expect(events[0].market).toBe("MarketABC");
    expect(events[0].timestamp).toBe(1700000000);
  });

  it("parses a SettlementEvent", () => {
    const coder = makeMockCoder(() => ({
      name: "SettlementEvent",
      data: { market: "MktSettle", timestamp: 999 },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: AAAA`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("settlement");
  });

  it("parses a CrankCancelEvent", () => {
    const coder = makeMockCoder(() => ({
      name: "CrankCancelEvent",
      data: { market: "MktCrank" },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: BBBB`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("crank_cancel");
  });

  // ---- Program data: line detection ----

  it("correctly identifies 'Program data:' lines and ignores other log lines", () => {
    let decodeCalls = 0;
    const coder = makeMockCoder((data: string) => {
      decodeCalls++;
      return { name: "FillEvent", data: { market: "M", timestamp: 1 } };
    });

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program log: some other log`,
      `Program log: another log`,
      `Program data: REAL_DATA`,
      `Program ${PROGRAM_ID} success`,
    ];

    parseEventsFromLogs(coder, logs, PROGRAM_ID);
    // Only the "Program data:" line should trigger decode
    expect(decodeCalls).toBe(1);
  });

  // ---- Context tracking (inside/outside program) ----

  it("ignores events from a different program", () => {
    const coder = makeMockCoder(() => ({
      name: "FillEvent",
      data: { market: "M", timestamp: 1 },
    }));

    const OTHER_PROGRAM = "OtherProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program data: AAAA`,
      `Program ${OTHER_PROGRAM} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  it("stops parsing after program failure", () => {
    const coder = makeMockCoder(() => ({
      name: "FillEvent",
      data: { market: "M", timestamp: 1 },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program ${PROGRAM_ID} failed: custom error`,
      `Program data: AAAA`, // after failure — should be ignored
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  // ---- Multiple events in one transaction ----

  it("parses multiple events from a single transaction", () => {
    let callCount = 0;
    const coder = makeMockCoder(() => {
      callCount++;
      return {
        name: callCount === 1 ? "FillEvent" : "SettlementEvent",
        data: { market: "M", timestamp: callCount },
      };
    });

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: FIRST`,
      `Program data: SECOND`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("fill");
    expect(events[1].type).toBe("settlement");
  });

  // ---- Decode returns null (non-event data) ----

  it("returns empty array when decode returns null for all lines", () => {
    const coder = makeMockCoder(() => null);

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: NOT_AN_EVENT`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  // ---- Unknown event name ----

  it("skips events with unknown names not in EVENT_TYPE_MAP", () => {
    const coder = makeMockCoder(() => ({
      name: "UnknownEvent",
      data: { market: "M", timestamp: 1 },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: AAAA`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  // ---- Malformed logs ----

  it("handles malformed logs gracefully (decode throws)", () => {
    const coder = makeMockCoder(() => {
      throw new Error("decode failed");
    });

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: GARBAGE`,
      `Program ${PROGRAM_ID} success`,
    ];

    // Should not throw
    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  it("handles empty logs array", () => {
    const coder = makeMockCoder(() => null);
    const events = parseEventsFromLogs(coder, [], PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  it("handles 'Program data: ' with no data after prefix", () => {
    const coder = makeMockCoder(() => null);
    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: `,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events).toHaveLength(0);
  });

  // ---- Data serialization ----

  it("serializes PublicKey-like objects (toBase58) in event data", () => {
    const coder = makeMockCoder(() => ({
      name: "FillEvent",
      data: {
        market: { toBase58: () => "PubkeyString123" },
        timestamp: 100,
        user: { toBase58: () => "UserPubkey456" },
      },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: AAAA`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events[0].market).toBe("PubkeyString123");
    expect(events[0].data.user).toBe("UserPubkey456");
  });

  it("serializes BN-like objects (toNumber) in event data", () => {
    const coder = makeMockCoder(() => ({
      name: "FillEvent",
      data: {
        market: "M",
        timestamp: { toNumber: () => 9999 },
        amount: { toNumber: () => 42 },
      },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: AAAA`,
      `Program ${PROGRAM_ID} success`,
    ];

    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    expect(events[0].timestamp).toBe(9999);
    expect(events[0].data.amount).toBe(42);
  });

  it("uses current time when event has no timestamp", () => {
    const coder = makeMockCoder(() => ({
      name: "CrankCancelEvent",
      data: { market: "M" },
    }));

    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: AAAA`,
      `Program ${PROGRAM_ID} success`,
    ];

    const now = Math.floor(Date.now() / 1000);
    const events = parseEventsFromLogs(coder, logs, PROGRAM_ID);
    // Timestamp should be approximately now (within 2 seconds)
    expect(events[0].timestamp).toBeGreaterThanOrEqual(now - 2);
    expect(events[0].timestamp).toBeLessThanOrEqual(now + 2);
  });
});
