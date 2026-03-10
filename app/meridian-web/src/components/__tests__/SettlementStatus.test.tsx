import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettlementStatus } from "../SettlementStatus";

// Mock "use client" — not needed in test env
vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return actual;
});

describe("SettlementStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows countdown when unsettled and market has not closed", () => {
    // Set current time to 1000 seconds before market close
    const now = 1700000000;
    vi.setSystemTime(new Date(now * 1000));

    const marketCloseUnix = now + 3661; // 1h 1m 1s away

    render(
      <SettlementStatus
        marketCloseUnix={marketCloseUnix}
        isSettled={false}
        outcome={0}
        overrideDeadline={0}
        settlementPrice={0}
        strikePrice={100_000_000}
      />,
    );

    // Should show countdown timer
    expect(screen.getByText("01:01:01")).toBeInTheDocument();
    // Should show "Market closes at" text
    expect(screen.getByText(/Market closes at/)).toBeInTheDocument();
  });

  it('shows "Settlement Under Review" during override window', () => {
    const now = 1700000000;
    vi.setSystemTime(new Date(now * 1000));

    render(
      <SettlementStatus
        marketCloseUnix={now - 3600} // market closed an hour ago
        isSettled={true}
        outcome={1}
        overrideDeadline={now + 600} // override window still open for 10 min
        settlementPrice={150_000_000}
        strikePrice={145_000_000}
      />,
    );

    expect(screen.getByText("Settlement Under Review")).toBeInTheDocument();
    expect(screen.getByText(/Redemptions available at/)).toBeInTheDocument();
  });

  it('shows "Settled — Yes wins" after override window with outcome=1', () => {
    const now = 1700000000;
    vi.setSystemTime(new Date(now * 1000));

    render(
      <SettlementStatus
        marketCloseUnix={now - 7200}
        isSettled={true}
        outcome={1}
        overrideDeadline={now - 600} // override window closed
        settlementPrice={150_000_000}
        strikePrice={145_000_000}
      />,
    );

    // The component renders &mdash; which is an em dash
    expect(screen.getByText(/Settled.*Yes wins at \$150\.00/)).toBeInTheDocument();
  });

  it('shows "Settled — No wins" after override window with outcome=2', () => {
    const now = 1700000000;
    vi.setSystemTime(new Date(now * 1000));

    render(
      <SettlementStatus
        marketCloseUnix={now - 7200}
        isSettled={true}
        outcome={2}
        overrideDeadline={now - 600}
        settlementPrice={140_000_000}
        strikePrice={145_000_000}
      />,
    );

    expect(screen.getByText(/Settled.*No wins at \$140\.00/)).toBeInTheDocument();
  });

  it("shows strike price in settled state", () => {
    const now = 1700000000;
    vi.setSystemTime(new Date(now * 1000));

    render(
      <SettlementStatus
        marketCloseUnix={now - 7200}
        isSettled={true}
        outcome={1}
        overrideDeadline={now - 600}
        settlementPrice={150_000_000}
        strikePrice={145_000_000}
      />,
    );

    expect(screen.getByText(/Strike: \$145\.00/)).toBeInTheDocument();
  });
});
