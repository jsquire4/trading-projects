/**
 * init-oracle-feeds.ts — Initialize PriceFeed accounts for all 7 MAG7 tickers
 * on the mock_oracle program.
 *
 * Idempotent: skips any feed whose PDA already exists on-chain.
 * Builds instructions manually using the Anchor discriminator convention.
 *
 * Run:  npx ts-node scripts/init-oracle-feeds.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const DEVNET_URL = "https://api.devnet.solana.com";
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

const MOCK_ORACLE_PROGRAM_ID = new PublicKey("HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ");

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Pad a ticker string to exactly 8 bytes (zero-padded). */
function tickerBytes(ticker: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  buf.write(ticker, "utf-8");
  return buf;
}

/** Compute Anchor instruction discriminator: first 8 bytes of SHA256("global:<instruction_name>"). */
function anchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.subarray(0, 8);
}

/** Derive PriceFeed PDA for a given ticker. */
function deriveFeedPda(ticker: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), tickerBytes(ticker)],
    MOCK_ORACLE_PROGRAM_ID
  );
}

(async () => {
  const connection = new Connection(DEVNET_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const disc = anchorDiscriminator("initialize_feed");

  let initialized = 0;
  let skipped = 0;

  for (const ticker of MAG7_TICKERS) {
    const [feedPda, bump] = deriveFeedPda(ticker);
    console.log(`\n[${ticker}] PDA: ${feedPda.toBase58()} (bump ${bump})`);

    // ── Idempotency check ────────────────────────────────────────────────────
    const existing = await connection.getAccountInfo(feedPda);
    if (existing) {
      console.log(`  Already exists (${existing.data.length} bytes). Skipping.`);
      skipped++;
      continue;
    }

    // ── Build instruction ────────────────────────────────────────────────────
    // Data: discriminator(8) + ticker([u8;8])
    const tBytes = tickerBytes(ticker);
    const data = Buffer.concat([disc, tBytes]);

    const keys = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },   // authority
      { pubkey: feedPda, isSigner: false, isWritable: true },           // price_feed
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({
      programId: MOCK_ORACLE_PROGRAM_ID,
      keys,
      data,
    });

    // ── Send transaction ─────────────────────────────────────────────────────
    console.log(`  Initializing feed...`);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
      commitment: "confirmed",
    });
    console.log(`  Done. Signature: ${sig}`);
    initialized++;
  }

  console.log(`\n=== Oracle feeds summary ===`);
  console.log(`  Initialized: ${initialized}`);
  console.log(`  Skipped:     ${skipped}`);
  console.log(`  Total:       ${MAG7_TICKERS.length}`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
