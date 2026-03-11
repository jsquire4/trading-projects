/**
 * create-mock-usdc.ts — Create a mock USDC SPL token mint on devnet.
 *
 * Idempotent: if USDC_MINT is already in .env, verifies the mint exists
 * on-chain and skips creation. Otherwise creates a new mint with 6 decimals,
 * a fresh faucet keypair as mint authority, and mints 1,000,000 USDC to
 * the admin's associated token account.
 *
 * Run:  npx ts-node scripts/create-mock-usdc.ts
 */

import {
  Connection,
  Keypair,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

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

function writeEnv(env: Record<string, string>): void {
  // Read existing file content to preserve comments and formatting
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
  const updatedKeys = new Set<string>();

  for (const [key, value] of Object.entries(env)) {
    // Match lines like KEY=value (not commented out)
    const regex = new RegExp(`^(${key})=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
      updatedKeys.add(key);
    }
  }

  // Append any new keys that weren't already in the file
  const newKeys = Object.entries(env).filter(([k]) => !updatedKeys.has(k));
  if (newKeys.length > 0) {
    // Ensure there's a trailing newline before appending
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    for (const [key, value] of newKeys) {
      content += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content);
}

(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`Admin pubkey: ${admin.publicKey.toBase58()}`);

  const env = readEnv();

  // ── Idempotency check ─────────────────────────────────────────────────────
  if (env["USDC_MINT"]) {
    console.log(`Mock USDC mint already exists: ${env["USDC_MINT"]}`);
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const mintPk = new PublicKey(env["USDC_MINT"]);
      const mintInfo = await getMint(connection, mintPk);
      console.log(
        `Verified on-chain: decimals=${mintInfo.decimals}, supply=${mintInfo.supply.toString()}`
      );
    } catch (e) {
      console.error("WARNING: USDC_MINT is in .env but could not be verified on-chain:", e);
    }
    return;
  }

  // ── Create faucet keypair (mint authority) ─────────────────────────────────
  const faucet = Keypair.generate();
  console.log(`Faucet (mint authority): ${faucet.publicKey.toBase58()}`);

  // ── Create mock USDC mint ──────────────────────────────────────────────────
  console.log("Creating mock USDC mint (6 decimals)...");
  const usdcMint = await createMint(
    connection,
    admin,           // payer
    faucet.publicKey, // mint authority
    null,             // freeze authority (none)
    6                 // decimals
  );
  console.log(`Mock USDC mint created: ${usdcMint.toBase58()}`);

  // ── Mint 1,000,000 USDC to admin's ATA ────────────────────────────────────
  console.log("Creating admin ATA and minting 1,000,000 USDC...");
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    admin.publicKey
  );

  const MILLION_USDC = 1_000_000 * 1_000_000; // 1M tokens × 10^6 decimals
  await mintTo(
    connection,
    admin,                 // payer
    usdcMint,              // mint
    adminAta.address,      // destination
    faucet,                // mint authority (signer)
    MILLION_USDC
  );
  console.log(`Minted 1,000,000 USDC to ${adminAta.address.toBase58()}`);

  // ── Write to .env ──────────────────────────────────────────────────────────
  const faucetSecretArray = Array.from(faucet.secretKey);
  const faucetJson = JSON.stringify(faucetSecretArray);

  env["FAUCET_KEYPAIR"] = faucetJson;
  env["USDC_MINT"] = usdcMint.toBase58();
  env["NEXT_PUBLIC_USDC_MINT"] = usdcMint.toBase58();

  writeEnv(env);
  console.log("Updated .env with FAUCET_KEYPAIR, USDC_MINT, NEXT_PUBLIC_USDC_MINT");

  console.log("\n=== Mock USDC setup complete ===");
  console.log(`  Mint:     ${usdcMint.toBase58()}`);
  console.log(`  Faucet:   ${faucet.publicKey.toBase58()}`);
  console.log(`  Admin ATA: ${adminAta.address.toBase58()}`);
  console.log(`  Balance:  1,000,000 USDC`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
