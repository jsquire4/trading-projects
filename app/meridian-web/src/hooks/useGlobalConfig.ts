"use client";

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { useAnchorProgram } from "./useAnchorProgram";
import { findGlobalConfig } from "@/lib/pda";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedGlobalConfig {
  publicKey: PublicKey;
  admin: PublicKey;
  pendingAdmin: PublicKey | null;
  usdcMint: PublicKey;
  oracleProgram: PublicKey;
  stalenessThreshold: bigint;
  settlementStaleness: bigint;
  confidenceBps: bigint;
  isPaused: boolean;
  oracleType: number;
  tickers: string[];
  tickerCount: number;
  bump: number;
  feeBps: number;
  strikeCreationFee: bigint;
  operatingReserve: bigint;
  obligations: bigint;
  settlementBlackoutMinutes: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGlobalConfig() {
  const { program } = useAnchorProgram();
  const [configAddr] = findGlobalConfig();

  return useQuery<ParsedGlobalConfig | null>({
    queryKey: ["global-config"],
    queryFn: async () => {
      if (!program) return null;
      try {
        const raw = await program.account.globalConfig.fetch(configAddr) as Record<string, unknown>;

        // Decode tickers from u8[8][7] array
        const tickerArrays = raw.tickers as number[][];
        const tickerCount = raw.tickerCount as number;
        const tickers: string[] = [];
        for (let i = 0; i < tickerCount; i++) {
          const t = Buffer.from(tickerArrays[i]).toString("utf-8").replace(/\0+$/, "");
          if (t) tickers.push(t);
        }

        // Parse pending_admin — Pubkey::default() means no pending transfer
        const pendingAdminRaw = raw.pendingAdmin as PublicKey;
        const pendingAdmin = pendingAdminRaw.equals(PublicKey.default)
          ? null
          : pendingAdminRaw;

        return {
          publicKey: configAddr,
          admin: raw.admin as PublicKey,
          pendingAdmin,
          usdcMint: raw.usdcMint as PublicKey,
          oracleProgram: raw.oracleProgram as PublicKey,
          stalenessThreshold: BigInt((raw.stalenessThreshold as any).toString()),
          settlementStaleness: BigInt((raw.settlementStaleness as any).toString()),
          confidenceBps: BigInt((raw.confidenceBps as any).toString()),
          isPaused: raw.isPaused as boolean,
          oracleType: raw.oracleType as number,
          tickers,
          tickerCount,
          bump: raw.bump as number,
          feeBps: raw.feeBps as number,
          strikeCreationFee: BigInt((raw.strikeCreationFee as any).toString()),
          operatingReserve: BigInt((raw.operatingReserve as any).toString()),
          obligations: BigInt((raw.obligations as any).toString()),
          settlementBlackoutMinutes: raw.settlementBlackoutMinutes as number,
        };
      } catch {
        return null;
      }
    },
    enabled: !!program,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
