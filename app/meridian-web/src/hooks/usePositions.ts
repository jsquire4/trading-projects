"use client";

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarkets, type ParsedMarket } from "./useMarkets";

export interface Position {
  market: ParsedMarket;
  yesBal: bigint;
  noBal: bigint;
  yesAta: PublicKey;
  noAta: PublicKey;
}

export function usePositions() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { data: markets = [] } = useMarkets();

  return useQuery<Position[]>({
    queryKey: ["positions", publicKey?.toBase58() ?? null, markets.map((m) => m.publicKey.toBase58()).join(",")],
    queryFn: async () => {
      if (!publicKey || !connected || markets.length === 0) return [];

      // Fetch all token accounts for this wallet
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID },
        "confirmed",
      );

      // Build mint → balance map
      const balances = new Map<string, bigint>();
      for (const { account } of tokenAccounts.value) {
        const data = account.data;
        if (data.length < 72) continue;
        const mint = new PublicKey(data.subarray(0, 32));
        const amount = data.readBigUInt64LE(64);
        balances.set(mint.toBase58(), amount);
      }

      // Match against market mints
      const positions: Position[] = [];
      for (const market of markets) {
        const yesKey = market.yesMint.toBase58();
        const noKey = market.noMint.toBase58();
        const yesBal = balances.get(yesKey) ?? BigInt(0);
        const noBal = balances.get(noKey) ?? BigInt(0);

        if (yesBal > BigInt(0) || noBal > BigInt(0)) {
          const yesAta = await getAssociatedTokenAddress(market.yesMint, publicKey);
          const noAta = await getAssociatedTokenAddress(market.noMint, publicKey);
          positions.push({ market, yesBal, noBal, yesAta, noAta });
        }
      }

      return positions;
    },
    enabled: !!publicKey && connected && markets.length > 0,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
