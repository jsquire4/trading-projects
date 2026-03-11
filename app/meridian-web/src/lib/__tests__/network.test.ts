import { describe, it, expect } from "vitest";
import {
  getClusterFromRpcUrl,
  getExplorerUrl,
  type NetworkCluster,
} from "../network";

describe("getClusterFromRpcUrl", () => {
  it("detects mainnet from URL containing 'mainnet'", () => {
    expect(getClusterFromRpcUrl("https://api.mainnet-beta.solana.com")).toBe(
      "mainnet-beta",
    );
  });

  it("detects mainnet from custom RPC with 'mainnet' in path", () => {
    expect(
      getClusterFromRpcUrl("https://rpc.helius.xyz/?api-key=abc&cluster=mainnet"),
    ).toBe("mainnet-beta");
  });

  it("detects devnet from URL containing 'devnet'", () => {
    expect(getClusterFromRpcUrl("https://api.devnet.solana.com")).toBe("devnet");
  });

  it("returns localnet for localhost URLs", () => {
    expect(getClusterFromRpcUrl("http://localhost:8899")).toBe("localnet");
  });

  it("returns localnet for unknown URLs", () => {
    expect(getClusterFromRpcUrl("http://127.0.0.1:8899")).toBe("localnet");
  });
});

describe("getExplorerUrl", () => {
  const sig = "5abc123def456";

  it("generates mainnet URL without cluster param", () => {
    const url = getExplorerUrl(sig, "mainnet-beta");
    expect(url).toBe(`https://explorer.solana.com/tx/${sig}`);
    expect(url).not.toContain("cluster");
  });

  it("generates devnet URL with cluster=devnet", () => {
    const url = getExplorerUrl(sig, "devnet");
    expect(url).toBe(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  });

  it("generates localnet URL with custom cluster param", () => {
    const url = getExplorerUrl(sig, "localnet");
    expect(url).toContain(`tx/${sig}`);
    expect(url).toContain("cluster=custom");
    expect(url).toContain("customUrl=");
    expect(url).toContain(encodeURIComponent("http://localhost:8899"));
  });

  it("produces valid URLs for all clusters", () => {
    const clusters: NetworkCluster[] = ["mainnet-beta", "devnet", "localnet"];
    for (const cluster of clusters) {
      expect(() => new URL(getExplorerUrl(sig, cluster))).not.toThrow();
    }
  });
});
