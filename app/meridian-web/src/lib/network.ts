export type NetworkCluster = "mainnet-beta" | "devnet" | "localnet";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export function getClusterFromRpcUrl(rpcUrl: string): NetworkCluster {
  if (rpcUrl.includes("mainnet")) return "mainnet-beta";
  if (rpcUrl.includes("devnet")) return "devnet";
  return "localnet";
}

export function getExplorerUrl(signature: string, cluster?: NetworkCluster): string {
  const resolved = cluster ?? getClusterFromRpcUrl(RPC_URL);
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (resolved === "mainnet-beta") return base;
  if (resolved === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent("http://localhost:8899")}`;
}

export function getCurrentCluster(): NetworkCluster {
  return getClusterFromRpcUrl(RPC_URL);
}
