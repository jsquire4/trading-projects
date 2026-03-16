import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PayoffDisplay } from "../PayoffDisplay";

describe("PayoffDisplay", () => {
  it("Buy Yes side shows correct payoff text with price and strike", () => {
    render(
      <PayoffDisplay
        side="yes"
        action="buy"
        price={65}
        ticker="AAPL"
        strikePrice={180_000_000}
      />,
    );

    expect(screen.getByText("Buy Yes Payoff")).toBeInTheDocument();
    expect(screen.getByText("$0.65")).toBeInTheDocument();
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText(/AAPL closes at or above \$180\.00/)).toBeInTheDocument();
    expect(screen.getByText(/You pay/)).toBeInTheDocument();
  });

  it("Sell Yes side shows seller-perspective copy", () => {
    render(
      <PayoffDisplay
        side="yes"
        action="sell"
        price={65}
        ticker="AAPL"
        strikePrice={180_000_000}
      />,
    );

    expect(screen.getByText("Sell Yes Payoff")).toBeInTheDocument();
    expect(screen.getByText(/You receive/)).toBeInTheDocument();
    expect(screen.getByText(/You owe/)).toBeInTheDocument();
    // Seller max profit = price, max loss = 100-price
    expect(screen.getByText(/Max profit: \$0\.65/)).toBeInTheDocument();
    expect(screen.getByText(/Max loss: \$0\.35/)).toBeInTheDocument();
  });

  it("Buy No side shows correct payoff text", () => {
    render(
      <PayoffDisplay
        side="no"
        action="buy"
        price={35}
        ticker="TSLA"
        strikePrice={250_000_000}
      />,
    );

    expect(screen.getByText("Buy No Payoff")).toBeInTheDocument();
    expect(screen.getByText("$0.35")).toBeInTheDocument();
    expect(screen.getByText(/TSLA closes below \$250\.00/)).toBeInTheDocument();
    expect(screen.getByText(/You pay/)).toBeInTheDocument();
  });

  it("Sell No side shows seller-perspective copy", () => {
    render(
      <PayoffDisplay
        side="no"
        action="sell"
        price={35}
        ticker="TSLA"
        strikePrice={250_000_000}
      />,
    );

    expect(screen.getByText("Sell No Payoff")).toBeInTheDocument();
    expect(screen.getByText(/You receive/)).toBeInTheDocument();
    expect(screen.getByText(/You owe/)).toBeInTheDocument();
  });

  it("buy-side max profit and max loss are calculated correctly", () => {
    render(
      <PayoffDisplay
        side="yes"
        action="buy"
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
        action="buy"
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
        action="buy"
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
