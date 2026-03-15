/**
 * useVaultBalance.test.ts — Shared vault-balance test covering the common
 * pattern used by both useTreasuryBalance and useFeeVaultBalance.
 *
 * Both hooks follow the same structure:
 *   1. Derive a PDA via findXxx()
 *   2. Call connection.getTokenAccountBalance(pda)
 *   3. Convert lamports to USDC dollars (lamports / 1e6)
 *   4. Return null on error
 *
 * NOTE: useTreasuryBalance.test.ts and useFeeVaultBalance.test.ts duplicate
 * this logic. Once the hooks are refactored to share a common factory (e.g.
 * createVaultBalanceHook(pdaFinder, queryKey)), those per-hook test files
 * can be replaced by parameterized tests in this file.
 */

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
    findFeeVault: () => [new PublicKey(FAKE_ADDR_STR), 255],
  };
});

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({
    connection: { getTokenAccountBalance: mockGetTokenAccountBalance },
  }),
}));

import { useTreasuryBalance } from "../useTreasuryBalance";
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
// Shared behavior tests
// ---------------------------------------------------------------------------

describe.each([
  { name: "useTreasuryBalance", useHook: useTreasuryBalance },
  { name: "useFeeVaultBalance", useHook: useFeeVaultBalance },
])("$name (shared vault balance pattern)", ({ useHook }) => {
  beforeEach(() => {
    mockGetTokenAccountBalance.mockReset();
  });

  it("converts lamports to USDC dollars", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "5000000" }, // 5 USDC
    });

    const { result } = renderHook(() => useHook(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data!.balance).toBe(5);
  });

  it("returns zero balance correctly", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "0" },
    });

    const { result } = renderHook(() => useHook(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data!.balance).toBe(0);
  });

  it("returns null on fetch error", async () => {
    mockGetTokenAccountBalance.mockRejectedValue(new Error("Account not found"));

    const { result } = renderHook(() => useHook(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("queries the correct PDA address", async () => {
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000" },
    });

    renderHook(() => useHook(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockGetTokenAccountBalance).toHaveBeenCalled());

    const calledAddr = mockGetTokenAccountBalance.mock.calls[0][0];
    expect(calledAddr.toBase58()).toBe(FAKE_ADDR_STR);
  });
});
