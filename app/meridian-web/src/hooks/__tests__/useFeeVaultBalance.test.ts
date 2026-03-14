import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures values are available when vi.mock factories run
// ---------------------------------------------------------------------------

const mockGetTokenAccountBalance = vi.fn();
// Use a deterministic fake address (valid base58, 32 bytes)
const FAKE_ADDR_STR = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

vi.mock("@/lib/pda", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    findFeeVault: () => [new PublicKey(FAKE_ADDR_STR), 255],
  };
});

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({
    connection: { getTokenAccountBalance: mockGetTokenAccountBalance },
  }),
}));

import { useFeeVaultBalance } from "../useFeeVaultBalance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFeeVaultBalance", () => {
  beforeEach(() => {
    mockGetTokenAccountBalance.mockReset();
  });

  it("returns balance in USDC dollars", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "5000000" },
    });

    const { result } = renderHook(() => useFeeVaultBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data!.balance).toBe(5);
    expect(result.current.data!.lamports).toBe(BigInt(5_000_000));
  });

  it("returns zero balance correctly (not null)", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "0" },
    });

    const { result } = renderHook(() => useFeeVaultBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data!.balance).toBe(0);
  });

  it("returns null on fetch error", async () => {
    mockGetTokenAccountBalance.mockRejectedValue(new Error("Account not found"));

    const { result } = renderHook(() => useFeeVaultBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("queries the correct PDA address", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000" },
    });

    renderHook(() => useFeeVaultBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockGetTokenAccountBalance).toHaveBeenCalled());

    const calledAddr = mockGetTokenAccountBalance.mock.calls[0][0];
    expect(calledAddr.toBase58()).toBe(FAKE_ADDR_STR);
  });
});
