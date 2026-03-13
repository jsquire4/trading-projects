import { useMemo } from "react";
import { getClusterFromRpcUrl, type NetworkCluster } from "../lib/network";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

// Pre-compute cluster once at module load since RPC_URL is a constant
const _cluster = getClusterFromRpcUrl(RPC_URL);

export function useNetwork() {
  // useMemo with [] is retained for test mockability (vi.mock replaces this function)
  return useMemo(() => ({
    cluster: _cluster,
    isMainnet: _cluster === "mainnet-beta",
    isDevnet: _cluster === "devnet",
    isLocalnet: _cluster === "localnet",
    rpcUrl: RPC_URL,
  }), []);
}

export type { NetworkCluster };
