import { useMemo } from "react";
import { getClusterFromRpcUrl, type NetworkCluster } from "../lib/network";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export function useNetwork() {
  return useMemo(() => {
    const cluster = getClusterFromRpcUrl(RPC_URL);
    return {
      cluster,
      isMainnet: cluster === "mainnet-beta",
      isDevnet: cluster === "devnet",
      isLocalnet: cluster === "localnet",
      rpcUrl: RPC_URL,
    };
  }, []);
}

export type { NetworkCluster };
