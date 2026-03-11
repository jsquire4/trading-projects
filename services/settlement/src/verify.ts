#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Settlement — Verification stub
//
// Checks that all markets past their close time have been settled.
// Spawned by the scheduler at 4:10 PM ET (5 min after settlement service).
//
// Exit 0 = all expired markets settled, Exit 1 = unsettled markets found.
// ---------------------------------------------------------------------------

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig } from "../../shared/src/pda.js";
import { tickerFromBytes } from "./settler.js";

import meridianIdl from "../../shared/src/idl/meridian.json" with { type: "json" };

const log = createLogger("settlement:verify");

async function main(): Promise<void> {
  log.info("Settlement verification starting");

  // ---- Environment ---------------------------------------------------------
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const adminSecret = process.env.ADMIN_KEYPAIR;
  if (!adminSecret) {
    throw new Error("ADMIN_KEYPAIR env var is required (base58 secret key)");
  }

  const adminKeypair = Keypair.fromSecretKey(bs58.decode(adminSecret));
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(meridianIdl as any, provider);

  // ---- Load all StrikeMarket accounts via IDL fetch ------------------------
  const allMarkets = await program.account.strikeMarket.all();
  const now = Math.floor(Date.now() / 1000);

  log.info(`Found ${allMarkets.length} total markets`);

  // ---- Check for expired but unsettled markets -----------------------------
  const unsettled: { ticker: string; pubkey: string; closeUnix: number }[] = [];

  for (const m of allMarkets) {
    const isSettled = m.account.isSettled as boolean;
    const marketCloseUnix = (m.account.marketCloseUnix as any).toNumber();

    if (!isSettled && marketCloseUnix <= now) {
      const ticker = tickerFromBytes(m.account.ticker as number[]);
      unsettled.push({
        ticker,
        pubkey: m.publicKey.toBase58(),
        closeUnix: marketCloseUnix,
      });
    }
  }

  if (unsettled.length === 0) {
    log.info("All expired markets have been settled");
    process.exit(0);
  }

  log.error(`${unsettled.length} market(s) past close time but NOT settled`, {
    unsettled,
  });
  process.exit(1);
}

main().catch((err) => {
  log.critical("Fatal error in settlement verification", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
