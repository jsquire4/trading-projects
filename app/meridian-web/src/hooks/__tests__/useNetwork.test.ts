import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Store original env
const originalEnv = process.env.NEXT_PUBLIC_RPC_URL;

describe("useNetwork", () => {
  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_RPC_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_RPC_URL;
    }
    vi.resetModules();
  });

  it("detects localnet from default RPC URL", async () => {
    delete process.env.NEXT_PUBLIC_RPC_URL;
    const { useNetwork } = await import("../useNetwork");
    const { result } = renderHook(() => useNetwork());
    // Default fallback is localnet
    expect(result.current.cluster).toBe("localnet");
    expect(result.current.isLocalnet).toBe(true);
    expect(result.current.isMainnet).toBe(false);
    expect(result.current.isDevnet).toBe(false);
  });

  it("detects mainnet from RPC URL", async () => {
    process.env.NEXT_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
    const { useNetwork } = await import("../useNetwork");
    const { result } = renderHook(() => useNetwork());
    expect(result.current.cluster).toBe("mainnet-beta");
    expect(result.current.isMainnet).toBe(true);
    expect(result.current.isDevnet).toBe(false);
  });

  it("detects localnet from localhost URL", async () => {
    process.env.NEXT_PUBLIC_RPC_URL = "http://localhost:8899";
    const { useNetwork } = await import("../useNetwork");
    const { result } = renderHook(() => useNetwork());
    expect(result.current.cluster).toBe("localnet");
    expect(result.current.isLocalnet).toBe(true);
    expect(result.current.isMainnet).toBe(false);
  });

  it("returns rpcUrl property", async () => {
    process.env.NEXT_PUBLIC_RPC_URL = "https://api.devnet.solana.com";
    const { useNetwork } = await import("../useNetwork");
    const { result } = renderHook(() => useNetwork());
    expect(result.current.rpcUrl).toBe("https://api.devnet.solana.com");
  });
});
