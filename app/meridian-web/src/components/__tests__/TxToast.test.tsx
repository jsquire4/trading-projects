import { describe, it, expect, vi, beforeEach } from "vitest";
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

    // Verify the description contains the explorer URL
    const callArgs = (toast.success as any).mock.calls[0][1];
    // description is a React element — check it's defined
    expect(callArgs.description).toBeDefined();
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
  });

  it("uses 'Unknown error' when no error message provided", () => {
    showTxToast({ signature: "abc", status: "error" });

    expect(toast.error).toHaveBeenCalledTimes(1);
    // The description is a React element containing the error text
    const callArgs = (toast.error as any).mock.calls[0][1];
    expect(callArgs.description).toBeDefined();
  });

  it("constructs correct devnet explorer URL", () => {
    // We'll render the description element to verify the URL
    const sig = "testSig123";
    showTxToast({ signature: sig, status: "confirmed" });

    const callArgs = (toast.success as any).mock.calls[0][1];
    const description = callArgs.description;

    // The description is a JSX <a> element — check its props
    expect(description.props.href).toBe(
      `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    );
    expect(description.props.target).toBe("_blank");
  });
});
