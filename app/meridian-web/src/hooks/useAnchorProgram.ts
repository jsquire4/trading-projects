"use client";

import { useMemo } from "react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/meridian.json";
import type { Meridian } from "@/idl/meridian";

/**
 * Returns a typed Anchor Program instance for the Meridian program.
 *
 * When no wallet is connected the provider is created in read-only mode
 * (transactions will fail, but account reads still work).
 */
export function useAnchorProgram(): {
  program: Program<Meridian> | null;
  provider: AnchorProvider | null;
} {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const result = useMemo(() => {
    // We need at least a connection to do anything useful
    if (!connection) return { program: null, provider: null };

    // Build the provider. If no wallet is connected, use a dummy that
    // allows read-only operations (account fetches, subscriptions).
    const provider = wallet
      ? new AnchorProvider(connection, wallet, {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        })
      : new AnchorProvider(
          connection,
          // Dummy wallet for read-only — signTransaction will throw if called
          {
            publicKey: PublicKey.default,
            signTransaction: () => {
              throw new Error("Wallet not connected");
            },
            signAllTransactions: () => {
              throw new Error("Wallet not connected");
            },
          },
          { commitment: "confirmed" },
        );

    const program = new Program<Meridian>(
      idl as unknown as Meridian,
      provider,
    );

    return { program, provider };
  }, [connection, wallet]);

  return result;
}
