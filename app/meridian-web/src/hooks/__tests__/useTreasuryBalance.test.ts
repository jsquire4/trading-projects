import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetTokenAccountBalance = vi.fn();
const FAKE_ADDR_STR = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

vi.mock("@/lib/pda", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    findTreasury: () => [new PublicKey(FAKE_ADDR_STR), 254],
  };
});

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({
    connection: { getTokenAccountBalance: mockGetTokenAccountBalance },
  }),
}));

import { useTreasuryBalance } from "../useTreasuryBalance";

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

describe("useTreasuryBalance", () => {
  beforeEach(() => {
    mockGetTokenAccountBalance.mockReset();
  });

  it("returns balance in USDC dollars", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "250000000" },
    });

    const { result } = renderHook(() => useTreasuryBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data!.balance).toBe(250);
  });

  it("returns zero balance correctly", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "0" },
    });

    const { result } = renderHook(() => useTreasuryBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data!.balance).toBe(0);
  });

  it("returns null on fetch error", async () => {
    mockGetTokenAccountBalance.mockRejectedValue(new Error("Account not found"));

    const { result } = renderHook(() => useTreasuryBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("queries the correct PDA address", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000" },
    });

    renderHook(() => useTreasuryBalance(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockGetTokenAccountBalance).toHaveBeenCalled());

    const calledAddr = mockGetTokenAccountBalance.mock.calls[0][0];
    expect(calledAddr.toBase58()).toBe(FAKE_ADDR_STR);
  });
});
