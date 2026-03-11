import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TradeConfirmationModal } from "../TradeConfirmationModal";

const defaultProps = {
  isOpen: true,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ticker: "AAPL",
  side: "Buy Yes",
  price: 65,
  quantity: 10,
  estimatedCost: 6.5,
};

describe("TradeConfirmationModal", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <TradeConfirmationModal {...defaultProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders trade details when open", () => {
    render(<TradeConfirmationModal {...defaultProps} />);
    expect(screen.getByText("AAPL")).toBeDefined();
    expect(screen.getByText("Buy Yes")).toBeDefined();
    expect(screen.getByText("65c")).toBeDefined();
    expect(screen.getByText("10")).toBeDefined();
    expect(screen.getByText("$6.50 USDC")).toBeDefined();
  });

  it("shows mainnet risk warning", () => {
    render(<TradeConfirmationModal {...defaultProps} />);
    expect(
      screen.getByText(/trading on Solana mainnet with real funds/),
    ).toBeDefined();
  });

  it("calls onConfirm when Confirm button clicked", () => {
    const onConfirm = vi.fn();
    render(<TradeConfirmationModal {...defaultProps} onConfirm={onConfirm} />);
    const buttons = screen.getAllByRole("button");
    const confirmBtn = buttons.find((b) => b.textContent === "Confirm Trade")!;
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel button clicked", () => {
    const onCancel = vi.fn();
    render(<TradeConfirmationModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
