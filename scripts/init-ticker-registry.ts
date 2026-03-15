#!/usr/bin/env npx tsx
/**
 * Initialize the TickerRegistry PDA on-chain. Idempotent — skips if it already exists.
 */
import { Connection, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const MERIDIAN = new PublicKey("G5zZw1GMzqwjfbRMjTi2qUXDwoUwLw83hjEuwLfVCZvy");

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const kpPath = process.env.KEYPAIR_PATH ?? `${os.homedir()}/.config/solana/id.json`;
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN);
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("tickers")], MERIDIAN);

  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`Config PDA: ${configPda.toBase58()}`);
  console.log(`TickerRegistry PDA: ${registryPda.toBase58()}`);

  const existing = await connection.getAccountInfo(registryPda);
  if (existing) {
    console.log("TickerRegistry already exists. Skipping.");
    return;
  }

  const disc = createHash("sha256").update("global:initialize_ticker_registry").digest().subarray(0, 8);
  const keys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: registryPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({ programId: MERIDIAN, keys, data: disc });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
  console.log(`TickerRegistry initialized: ${sig}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
