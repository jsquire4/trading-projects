import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { showTxToast } from "../TxToast";
import { toast } from "sonner";

// Mock sonner
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock network to return devnet explorer URLs in tests
vi.mock("@/lib/network", () => ({
  getExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
}));

describe("showTxToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates success toast with explorer link", () => {
    const sig = "5abc123def456";
    showTxToast({ signature: sig, status: "confirmed" });

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Transaction confirmed",
      expect.objectContaining({
        duration: 6000,
      }),
    );

    // Render the description and verify it contains an explorer link
    const callArgs = (toast.success as any).mock.calls[0][1];
    const { container } = render(callArgs.description);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("View on Explorer");
  });

  it("creates error toast with error message", () => {
    showTxToast({
      signature: "abc",
      status: "error",
      error: "Insufficient funds",
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Transaction failed",
      expect.objectContaining({
        duration: 8000,
      }),
    );

    // Verify the error message appears in the rendered description
    const callArgs = (toast.error as any).mock.calls[0][1];
    const { container } = render(callArgs.description);
    expect(container.textContent).toBe("Insufficient funds");
  });

  it("uses 'Unknown error' when no error message provided", () => {
    showTxToast({ signature: "abc", status: "error" });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const callArgs = (toast.error as any).mock.calls[0][1];
    // Render the description element and verify fallback text
    const { container } = render(callArgs.description);
    expect(container.textContent).toBe("Unknown error");
  });

  it("constructs correct devnet explorer URL", () => {
    const sig = "testSig123";
    showTxToast({ signature: sig, status: "confirmed" });

    const callArgs = (toast.success as any).mock.calls[0][1];
    // Render the description element and verify link
    const { container } = render(callArgs.description);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.href).toBe(
      `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    );
    expect(link!.target).toBe("_blank");
  });
});
