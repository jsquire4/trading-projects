import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarketCard, type MarketData } from "../MarketCard";

// Mock next/link to render a plain anchor
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const baseMarket: MarketData = {
  ticker: "AAPL",
  strikePrice: 180_000_000,
  isSettled: false,
  outcome: 0,
  bestBid: 45,
  bestAsk: 55,
  activeOrders: 12,
};

describe("MarketCard", () => {
  it("renders ticker and strike price", () => {
    render(<MarketCard market={baseMarket} />);

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText(/Strike: \$180\.00/)).toBeInTheDocument();
  });

  it("shows correct implied probability from midpoint", () => {
    // midpoint of 45 and 55 = 50
    render(<MarketCard market={baseMarket} />);

    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("shows Yes and No prices", () => {
    render(<MarketCard market={baseMarket} />);

    // Yes price = midpoint = 50c, No = 100 - 50 = 50c
    // Both are "50c" so there are two matching elements
    const prices = screen.getAllByText("50c");
    expect(prices).toHaveLength(2);
  });

  it('shows "Active" badge for unsettled market', () => {
    render(<MarketCard market={baseMarket} />);

    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it('shows "Settled - Yes Wins" badge for settled market with outcome 1', () => {
    const settled: MarketData = {
      ...baseMarket,
      isSettled: true,
      outcome: 1,
    };
    render(<MarketCard market={settled} />);

    expect(screen.getByText("Settled - Yes Wins")).toBeInTheDocument();
  });

  it('shows "Settled - No Wins" badge for settled market with outcome 2', () => {
    const settled: MarketData = {
      ...baseMarket,
      isSettled: true,
      outcome: 2,
    };
    render(<MarketCard market={settled} />);

    expect(screen.getByText("Settled - No Wins")).toBeInTheDocument();
  });

  it("shows active order count", () => {
    render(<MarketCard market={baseMarket} />);

    expect(screen.getByText("12 active orders")).toBeInTheDocument();
  });

  it("shows singular 'order' for count of 1", () => {
    const market: MarketData = { ...baseMarket, activeOrders: 1 };
    render(<MarketCard market={market} />);

    expect(screen.getByText("1 active order")).toBeInTheDocument();
  });

  it('shows "--" when no bid/ask available', () => {
    const market: MarketData = {
      ...baseMarket,
      bestBid: null,
      bestAsk: null,
    };
    render(<MarketCard market={market} />);

    // Both Yes and No should show "--"
    const dashes = screen.getAllByText("--");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("links to the correct trade page", () => {
    render(<MarketCard market={baseMarket} />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/trade/AAPL");
  });
});
