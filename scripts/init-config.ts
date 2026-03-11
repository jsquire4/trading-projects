/**
 * init-config.ts — Initialize the GlobalConfig PDA for the meridian program.
 *
 * Idempotent: skips if the config account already exists on-chain.
 * Builds the instruction manually (no IDL needed) using the Anchor
 * discriminator convention: SHA256("global:initialize_config")[0..8].
 *
 * Run:  npx ts-node scripts/init-config.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

import { MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID } from "./shared";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
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

(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  // ── Read USDC_MINT from .env ───────────────────────────────────────────────
  const env = readEnv();
  if (!env["USDC_MINT"]) {
    console.error("ERROR: USDC_MINT not found in .env. Run create-mock-usdc.ts first.");
    process.exit(1);
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  console.log(`USDC Mint: ${usdcMint.toBase58()}`);

  // ── Derive PDAs ────────────────────────────────────────────────────────────
  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID
  );
  console.log(`Config PDA: ${configPda.toBase58()} (bump ${configBump})`);

  const [treasuryPda, treasuryBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    MERIDIAN_PROGRAM_ID
  );
  console.log(`Treasury PDA: ${treasuryPda.toBase58()} (bump ${treasuryBump})`);

  // ── Idempotency check ─────────────────────────────────────────────────────
  const existingAccount = await connection.getAccountInfo(configPda);
  if (existingAccount) {
    console.log("GlobalConfig already exists on-chain. Skipping initialization.");
    return;
  }

  // ── Build instruction data ─────────────────────────────────────────────────
  // Layout: discriminator(8) + tickers(7×8=56) + ticker_count(1) + staleness_threshold(8)
  //         + settlement_staleness(8) + confidence_bps(8) + oracle_type(1)
  const disc = anchorDiscriminator("initialize_config");

  // Tickers: [[u8; 8]; 7] — contiguous 56 bytes
  const tickersData = Buffer.concat(MAG7_TICKERS.map(tickerBytes));

  // Scalar args
  const tickerCount = Buffer.from([7]);
  const stalenessThreshold = new BN(60).toArrayLike(Buffer, "le", 8);
  const settlementStaleness = new BN(120).toArrayLike(Buffer, "le", 8);
  const confidenceBps = new BN(50).toArrayLike(Buffer, "le", 8);
  const oracleType = Buffer.from([0]); // Mock

  const data = Buffer.concat([
    disc,
    tickersData,
    tickerCount,
    stalenessThreshold,
    settlementStaleness,
    confidenceBps,
    oracleType,
  ]);

  // ── Build accounts list (must match InitializeConfig struct order) ─────────
  const keys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },   // admin
    { pubkey: configPda, isSigner: false, isWritable: true },         // config
    { pubkey: usdcMint, isSigner: false, isWritable: false },         // usdc_mint
    { pubkey: treasuryPda, isSigner: false, isWritable: true },       // treasury
    { pubkey: MOCK_ORACLE_PROGRAM_ID, isSigner: false, isWritable: false }, // oracle_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
  ];

  const ix = new TransactionInstruction({
    programId: MERIDIAN_PROGRAM_ID,
    keys,
    data,
  });

  // ── Send transaction ───────────────────────────────────────────────────────
  console.log("Sending initialize_config transaction...");
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
  });

  console.log(`\n=== GlobalConfig initialized ===`);
  console.log(`  Signature: ${sig}`);
  console.log(`  Config:    ${configPda.toBase58()}`);
  console.log(`  Treasury:  ${treasuryPda.toBase58()}`);
  console.log(`  Tickers:   ${MAG7_TICKERS.join(", ")}`);
  console.log(`  Oracle:    Mock (type=0)`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
