import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PayoffDisplay } from "../PayoffDisplay";

describe("PayoffDisplay", () => {
  it("Yes side shows correct payoff text with price and strike", () => {
    render(
      <PayoffDisplay
        side="yes"
        price={65}
        ticker="AAPL"
        strikePrice={180_000_000}
      />,
    );

    expect(screen.getByText("Yes Payoff")).toBeInTheDocument();
    expect(screen.getByText("$0.65")).toBeInTheDocument();
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("$180.00")).toBeInTheDocument();
    expect(screen.getByText(/closes at or above/)).toBeInTheDocument();
  });

  it("No side shows correct payoff text", () => {
    render(
      <PayoffDisplay
        side="no"
        price={35}
        ticker="TSLA"
        strikePrice={250_000_000}
      />,
    );

    expect(screen.getByText("No Payoff")).toBeInTheDocument();
    expect(screen.getByText("$0.35")).toBeInTheDocument();
    expect(screen.getByText("TSLA")).toBeInTheDocument();
    expect(screen.getByText("$250.00")).toBeInTheDocument();
    expect(screen.getByText(/closes below/)).toBeInTheDocument();
  });

  it("max profit and max loss are calculated correctly", () => {
    render(
      <PayoffDisplay
        side="yes"
        price={40}
        ticker="AAPL"
        strikePrice={180_000_000}
      />,
    );

    // Max profit = (100 - price) / 100 = $0.60
    // Max loss = price / 100 = $0.40
    expect(screen.getByText(/Max profit: \$0\.60/)).toBeInTheDocument();
    expect(screen.getByText(/Max loss: \$0\.40/)).toBeInTheDocument();
  });

  it("handles edge case price of 1 cent", () => {
    render(
      <PayoffDisplay
        side="yes"
        price={1}
        ticker="SPY"
        strikePrice={500_000_000}
      />,
    );

    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByText(/Max profit: \$0\.99/)).toBeInTheDocument();
    expect(screen.getByText(/Max loss: \$0\.01/)).toBeInTheDocument();
  });

  it("handles edge case price of 99 cents", () => {
    render(
      <PayoffDisplay
        side="no"
        price={99}
        ticker="SPY"
        strikePrice={500_000_000}
      />,
    );

    expect(screen.getByText("$0.99")).toBeInTheDocument();
    expect(screen.getByText(/Max profit: \$0\.01/)).toBeInTheDocument();
    expect(screen.getByText(/Max loss: \$0\.99/)).toBeInTheDocument();
  });
});
