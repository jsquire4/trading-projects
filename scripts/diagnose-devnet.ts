/**
 * diagnose-devnet.ts — Read on-chain state and print diagnostic info
 * for debugging CreateMarketPanel "simulation reverted" errors.
 *
 * Run: npx ts-node scripts/diagnose-devnet.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const MERIDIAN = new PublicKey("G5zZw1GMzqwjfbRMjTi2qUXDwoUwLw83hjEuwLfVCZvy");
const MOCK_ORACLE = new PublicKey("Az6BVaQwfoSqDyyn3TyvgfavoVKN4Qm8wLbMWm5EceFC");

function padTicker(t: string): Buffer {
  const buf = Buffer.alloc(8, 0);
  Buffer.from(t).copy(buf);
  return buf;
}

function findPda(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  const c = new Connection(RPC, "confirmed");

  // Admin keypair address
  const adminKeyPath = os.homedir() + "/.config/solana/id.json";
  let adminPubkey: PublicKey | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(adminKeyPath, "utf8"));
    const { Keypair } = await import("@solana/web3.js");
    adminPubkey = Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey;
  } catch { /* ignore */ }

  console.log("=== Meridian Devnet Diagnostics ===\n");
  console.log(`RPC:          ${RPC}`);
  console.log(`Meridian:     ${MERIDIAN.toBase58()}`);
  console.log(`Mock Oracle:  ${MOCK_ORACLE.toBase58()}`);
  console.log(`CLI Keypair:  ${adminPubkey?.toBase58() ?? "NOT FOUND"}`);

  // ── Cluster clock vs local clock ──────────────────────────────────────────
  const slot = await c.getSlot();
  const blockTime = await c.getBlockTime(slot);
  const localTime = Math.floor(Date.now() / 1000);
  console.log(`\n── Clock Skew ──`);
  console.log(`Local time:   ${localTime} (${new Date(localTime * 1000).toISOString()})`);
  console.log(`Cluster time: ${blockTime} (${blockTime ? new Date(blockTime * 1000).toISOString() : "null"})`);
  if (blockTime) {
    const skew = localTime - blockTime;
    console.log(`Skew:         ${skew}s (local is ${skew > 0 ? "AHEAD" : "BEHIND"} of cluster)`);
    if (skew > 0) {
      console.log(`  ⚠  update_price with Date.now() will FAIL if skew > 0`);
    }
  }

  // ── GlobalConfig ──────────────────────────────────────────────────────────
  const [configPda] = findPda([Buffer.from("config")], MERIDIAN);
  console.log(`\n── GlobalConfig (${configPda.toBase58()}) ──`);
  const configInfo = await c.getAccountInfo(configPda);
  if (!configInfo) {
    console.log("  ✗ DOES NOT EXIST on devnet!");
    console.log("  → Run init-config.ts with RPC_URL=https://api.devnet.solana.com");
    return;
  }
  console.log(`  ✓ Exists (${configInfo.data.length} bytes, owner: ${configInfo.owner.toBase58()})`);

  // Parse GlobalConfig fields manually
  // Layout after 8-byte discriminator:
  //   admin: Pubkey (32)
  //   usdc_mint: Pubkey (32)
  //   oracle_program: Pubkey (32)
  //   staleness_threshold: u64 (8)
  //   settlement_staleness: u64 (8)
  //   confidence_bps: u64 (8)
  //   is_paused: bool (1)
  //   oracle_type: u8 (1)
  //   tickers: [[u8;8];7] (56)
  //   ticker_count: u8 (1)
  //   bump: u8 (1)
  //   fee_bps: u16 (2)
  //   _padding: [u8;2] (2)
  //   strike_creation_fee: u64 (8)
  const d = configInfo.data;
  const configAdmin = new PublicKey(d.subarray(8, 40));
  const configUsdcMint = new PublicKey(d.subarray(40, 72));
  const configOracleProgram = new PublicKey(d.subarray(72, 104));
  const isPaused = d[128] !== 0;
  const oracleType = d[129];
  const tickerCount = d[186];
  const feeBps = d.readUInt16LE(188);
  const strikeCreationFee = d.readBigUInt64LE(192);

  console.log(`  admin:              ${configAdmin.toBase58()}`);
  console.log(`  oracle_program:     ${configOracleProgram.toBase58()}`);
  console.log(`  oracle_type:        ${oracleType} (${oracleType === 0 ? "Mock" : "Pyth"})`);
  console.log(`  is_paused:          ${isPaused}`);
  console.log(`  usdc_mint:          ${configUsdcMint.toBase58()}`);
  console.log(`  ticker_count:       ${tickerCount}`);
  console.log(`  fee_bps:            ${feeBps}`);
  console.log(`  strike_creation_fee: ${strikeCreationFee} (${Number(strikeCreationFee) / 1_000_000} USDC)`);

  // Validate oracle_program matches expected
  if (configOracleProgram.equals(MOCK_ORACLE)) {
    console.log(`  ✓ oracle_program matches MOCK_ORACLE`);
  } else {
    console.log(`  ✗ oracle_program MISMATCH! Expected ${MOCK_ORACLE.toBase58()}`);
    console.log(`    → This causes OracleProgramMismatch on every create_strike_market`);
  }

  // Validate admin matches CLI keypair
  if (adminPubkey && configAdmin.equals(adminPubkey)) {
    console.log(`  ✓ config.admin matches CLI keypair`);
  } else {
    console.log(`  ✗ config.admin DOES NOT match CLI keypair!`);
    console.log(`    → config.admin: ${configAdmin.toBase58()}`);
    console.log(`    → CLI keypair:  ${adminPubkey?.toBase58() ?? "unknown"}`);
  }

  // ── Ticker Registry ───────────────────────────────────────────────────────
  const [registryPda] = findPda([Buffer.from("tickers")], MERIDIAN);
  console.log(`\n── Ticker Registry (${registryPda.toBase58()}) ──`);
  const registryInfo = await c.getAccountInfo(registryPda);
  if (!registryInfo) {
    console.log("  ✗ DOES NOT EXIST on devnet!");
  } else {
    console.log(`  ✓ Exists (${registryInfo.data.length} bytes)`);
    // Parse entries: 8 disc + 1 bump + 7 padding + 4 vec_len + entries...
    // Each entry: ticker(8) + is_active(1) + pyth_feed(32) + _padding(7) = 48 bytes
    const rd = registryInfo.data;
    if (rd.length >= 20) {
      const vecLen = rd.readUInt32LE(16);
      console.log(`  entries: ${vecLen}`);
      for (let i = 0; i < vecLen; i++) {
        const offset = 20 + i * 48;
        if (offset + 48 > rd.length) break;
        const ticker = rd.subarray(offset, offset + 8).toString("utf8").replace(/\0+$/, "");
        const isActive = rd[offset + 8] !== 0;
        console.log(`    [${i}] "${ticker}" active=${isActive}`);
      }
    }
  }

  // ── Oracle Feed for F ─────────────────────────────────────────────────────
  const tickers = ["F", "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
  console.log(`\n── Oracle Feeds ──`);
  for (const ticker of tickers) {
    const [feedPda] = findPda([Buffer.from("price_feed"), padTicker(ticker)], MOCK_ORACLE);
    const feedInfo = await c.getAccountInfo(feedPda);
    if (!feedInfo) {
      console.log(`  ${ticker.padEnd(6)} ✗ no feed`);
      continue;
    }
    const fd = feedInfo.data;
    // Layout: disc(8) + ticker(8) + price(8) + confidence(8) + timestamp(8) + authority(32) + is_initialized(1) + bump(1)
    const price = fd.readBigUInt64LE(16);
    const timestamp = fd.readBigInt64LE(32);
    const authority = new PublicKey(fd.subarray(40, 72));
    const isInit = fd[72] !== 0;

    const priceStr = `$${(Number(price) / 1_000_000).toFixed(2)}`;
    const authorityMatch = adminPubkey && authority.equals(adminPubkey) ? "✓ admin" : `✗ ${authority.toBase58().slice(0, 8)}...`;
    const ownerMatch = feedInfo.owner.equals(MOCK_ORACLE) ? "✓" : `✗ owner=${feedInfo.owner.toBase58()}`;
    console.log(`  ${ticker.padEnd(6)} ${ownerMatch} init=${isInit} price=${priceStr} ts=${timestamp} authority=${authorityMatch}`);
  }

  // ── Check if F $10 market already exists ──────────────────────────────────
  console.log(`\n── Market PDAs (F $10, today's close) ──`);

  // Compute today's 4 PM ET close
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etStr);
  const target = new Date(etNow);
  target.setHours(16, 0, 0, 0);
  if (etNow >= target) target.setDate(target.getDate() + 1);
  const utcTarget = new Date(now.getTime() + (target.getTime() - etNow.getTime()));
  const closeUnix = Math.floor(utcTarget.getTime() / 1000);
  const expiryDay = Math.floor(closeUnix / 86400);

  console.log(`  close_unix:  ${closeUnix} (${new Date(closeUnix * 1000).toISOString()})`);
  console.log(`  expiry_day:  ${expiryDay}`);

  const strikeLamports = BigInt(10_000_000); // $10
  const strikeBuf = Buffer.alloc(8);
  strikeBuf.writeBigUInt64LE(strikeLamports);
  const expiryBuf = Buffer.alloc(4);
  expiryBuf.writeUInt32LE(expiryDay);

  const [marketPda] = findPda(
    [Buffer.from("market"), padTicker("F"), strikeBuf, expiryBuf],
    MERIDIAN,
  );
  const marketInfo = await c.getAccountInfo(marketPda);
  console.log(`  F $10 market: ${marketPda.toBase58()}`);
  if (marketInfo) {
    console.log(`    ✗ ALREADY EXISTS (${marketInfo.data.length} bytes)`);
    console.log(`    → create_strike_market will fail with "already in use"`);
  } else {
    console.log(`    ✓ Does not exist yet — creation should work`);
  }

  // ── SOL Treasury ──────────────────────────────────────────────────────────
  const [solTreasuryPda] = findPda([Buffer.from("sol_treasury")], MERIDIAN);
  const solTreasuryInfo = await c.getAccountInfo(solTreasuryPda);
  console.log(`\n── SOL Treasury (${solTreasuryPda.toBase58()}) ──`);
  if (!solTreasuryInfo) {
    console.log("  ✗ DOES NOT EXIST");
  } else {
    console.log(`  ✓ Balance: ${(solTreasuryInfo.lamports / 1_000_000_000).toFixed(4)} SOL`);
  }

  // ── Fee Vault ─────────────────────────────────────────────────────────────
  const [feeVaultPda] = findPda([Buffer.from("fee_vault")], MERIDIAN);
  const feeVaultInfo = await c.getAccountInfo(feeVaultPda);
  console.log(`\n── Fee Vault (${feeVaultPda.toBase58()}) ──`);
  if (!feeVaultInfo) {
    console.log("  ✗ DOES NOT EXIST");
  } else {
    console.log(`  ✓ Exists (owner: ${feeVaultInfo.owner.toBase58()})`);
  }

  // ── Admin SOL balance ─────────────────────────────────────────────────────
  if (adminPubkey) {
    const bal = await c.getBalance(adminPubkey);
    console.log(`\n── Admin Wallet ──`);
    console.log(`  SOL balance: ${(bal / 1_000_000_000).toFixed(4)} SOL`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
