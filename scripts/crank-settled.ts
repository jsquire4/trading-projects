/**
 * crank-settled.ts — Cancel all resting orders on settled markets.
 *
 * After settlement, resting orders still hold tokens in escrow.
 * This script cranks them all back to their owners so they can redeem.
 *
 * Run: npx ts-node scripts/crank-settled.ts
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import * as path from "path";

import {
  loadKeypair,
  readEnv,
  padTicker,
  anchorDiscriminator,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "./shared";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME ?? "~",
  ".config/solana/id.json",
);

const MAG7_PRICES: Record<string, number> = {
  AAPL: 198, MSFT: 420, GOOGL: 175, AMZN: 200,
  NVDA: 130, META: 600, TSLA: 250,
};

function roundToNearest(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

function generateStrikes(previousClose: number): number[] {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const increment = previousClose >= 100 ? 10 : 5;
  return [...new Set(offsets.map((pct) => roundToNearest(previousClose * (1 + pct), increment)))].sort((a, b) => a - b);
}

function expiryDayFromUnix(unix: number): number {
  return Math.floor(unix / 86400);
}

(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const env = readEnv(ENV_PATH);
  const usdcMint = new PublicKey(env["USDC_MINT"]);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PROGRAM_ID);

  // Today's 4 PM ET close (the markets were created with this expiry).
  // todayMarketCloseUnix() shifts to tomorrow after close, so compute directly.
  const now = new Date();
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const gp = (t: string) => etParts.find((p) => p.type === t)?.value ?? "0";
  const etYear = parseInt(gp("year"));
  const etMonth = parseInt(gp("month")) - 1;
  const etDay = parseInt(gp("day"));
  const etDateUtc = new Date(`${gp("year")}-${gp("month")}-${gp("day")}T${gp("hour")}:${gp("minute")}:${gp("second")}Z`);
  const etOffsetHours = Math.round((now.getTime() - etDateUtc.getTime()) / 3600000);
  const marketCloseUnix = Math.floor(new Date(Date.UTC(etYear, etMonth, etDay, 16 + etOffsetHours, 0, 0)).getTime() / 1000);
  const expiryDay = expiryDayFromUnix(marketCloseUnix);
  console.log(`Market close: ${new Date(marketCloseUnix * 1000).toISOString()} (expiry day ${expiryDay})`);

  const crankDisc = anchorDiscriminator("crank_cancel");
  let totalCranked = 0;

  for (const [ticker, price] of Object.entries(MAG7_PRICES)) {
    for (const strike of generateStrikes(price)) {
      const strikeLamports = new BN(strike * 1_000_000);
      const tBytes = padTicker(ticker);

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), tBytes, strikeLamports.toArrayLike(Buffer, "le", 8), new BN(expiryDay).toArrayLike(Buffer, "le", 4)],
        MERIDIAN_PROGRAM_ID,
      );

      // Check if market exists and is settled
      const marketAcct = await connection.getAccountInfo(marketPda);
      if (!marketAcct) continue;

      const marketData = marketAcct.data;
      // is_settled is a bool field — need to find offset
      // StrikeMarket layout after discriminator(8):
      //   config(32), oracle_feed(32), yes_mint(32), no_mint(32),
      //   usdc_vault(32), escrow_vault(32), yes_escrow(32), no_escrow(32), order_book(32)
      //   = 9 * 32 = 288 bytes of pubkeys starting at offset 8
      //   Then: ticker([u8;8]=8), strike_price(u64=8), previous_close(u64=8),
      //          market_close_unix(i64=8), expiry_day(u32=4),
      //          total_minted(u64=8), total_redeemed(u64=8),
      //          settlement_price(u64=8), settled_at(i64=8),
      //          override_deadline(i64=8), override_count(u8=1),
      //          outcome(u8=1), is_settled(bool=1), is_paused(bool=1), is_closed(bool=1)
      // Let's find is_settled by scanning for the outcome/settled pattern
      // Offset: 8 + 288 + 8 + 8 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1
      // = 8 + 288 = 296 (start of ticker)
      // + 8 (ticker) = 304 (strike_price)
      // + 8 = 312 (previous_close)
      // + 8 = 320 (market_close_unix)
      // + 8 = 328 (expiry_day as u32 + 4 padding? or packed?)
      // Actually, let me just check for settlement by checking if the outcome field > 0

      // Simpler: just try to read the order book and check for active orders
      const mkSeed = marketPda.toBuffer();
      const [orderBook] = PublicKey.findProgramAddressSync([Buffer.from("order_book"), mkSeed], MERIDIAN_PROGRAM_ID);
      const [yesMint] = PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), mkSeed], MERIDIAN_PROGRAM_ID);
      const [noMint] = PublicKey.findProgramAddressSync([Buffer.from("no_mint"), mkSeed], MERIDIAN_PROGRAM_ID);
      const [escrowVault] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), mkSeed], MERIDIAN_PROGRAM_ID);
      const [yesEscrow] = PublicKey.findProgramAddressSync([Buffer.from("yes_escrow"), mkSeed], MERIDIAN_PROGRAM_ID);
      const [noEscrow] = PublicKey.findProgramAddressSync([Buffer.from("no_escrow"), mkSeed], MERIDIAN_PROGRAM_ID);

      const obAcct = await connection.getAccountInfo(orderBook);
      if (!obAcct) continue;

      // Scan for active orders
      const data = obAcct.data;
      const levelsOffset = 8 + 32 + 8;
      interface ActiveOrder { owner: PublicKey; side: number; slotIdx: number; levelIdx: number }
      const activeOrders: ActiveOrder[] = [];

      for (let lvl = 0; lvl < 99; lvl++) {
        const levelBase = levelsOffset + lvl * 1288;
        const count = data[levelBase + 16 * 80];
        if (count === 0) continue;

        for (let slot = 0; slot < 16; slot++) {
          const slotBase = levelBase + slot * 80;
          const isActive = data[slotBase + 72];
          if (!isActive) continue;
          const owner = new PublicKey(data.subarray(slotBase, slotBase + 32));
          const side = data[slotBase + 56];
          activeOrders.push({ owner, side, slotIdx: slot, levelIdx: lvl });
        }
      }

      if (activeOrders.length === 0) continue;

      const label = `${ticker} $${strike}`;
      console.log(`${label}: ${activeOrders.length} active orders — cranking...`);

      // Build remaining accounts for crank_cancel
      const remainingAccounts = activeOrders.slice(0, 32).map((order) => {
        let mint: PublicKey;
        if (order.side === 0) mint = usdcMint;
        else if (order.side === 1) mint = yesMint;
        else mint = noMint;
        return {
          pubkey: getAssociatedTokenAddressSync(mint, order.owner, true),
          isSigner: false,
          isWritable: true,
        };
      });

      const batchSize = Math.min(activeOrders.length, 32);
      const crankData = Buffer.concat([crankDisc, Buffer.from([batchSize])]);

      const keys = [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: orderBook, isSigner: false, isWritable: true },
        { pubkey: escrowVault, isSigner: false, isWritable: true },
        { pubkey: yesEscrow, isSigner: false, isWritable: true },
        { pubkey: noEscrow, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ];

      try {
        const ix = new TransactionInstruction({ programId: MERIDIAN_PROGRAM_ID, keys, data: crankData });
        await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin], { commitment: "confirmed" });
        totalCranked += batchSize;
        console.log(`  Cranked ${batchSize} orders`);
      } catch (err: any) {
        // crank_cancel might fail if market not settled — that's fine, skip it
        const msg = err.message?.slice(0, 100) ?? "";
        if (msg.includes("MarketNotSettled") || msg.includes("0x6015")) {
          // Not settled yet, skip
        } else {
          console.error(`  FAILED: ${msg}`);
        }
      }
    }
  }

  console.log(`\nDone. Cranked ${totalCranked} total orders across settled markets.`);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
