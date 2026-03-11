/**
 * load-test.ts — Meridian binary options platform load test.
 *
 * Spins up 5 fresh wallets, funds each with SOL and USDC, mints Yes/No
 * token pairs, and places 100 total orders spread across 5 markets.
 * Verifies on-chain consistency and reports results.
 *
 * Prerequisites:
 *   - .env contains USDC_MINT and FAUCET_KEYPAIR (run create-mock-usdc.ts)
 *   - GlobalConfig PDA exists (run init-config.ts)
 *   - All 5 target markets exist on-chain (run create-test-markets.ts)
 *   - Oracle feeds exist for all tickers (run init-oracle-feeds.ts)
 *
 * Run: npx tsx scripts/load-test.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  loadKeypair,
  readEnv,
  anchorDiscriminator,
  padTicker,
  todayMarketCloseUnix,
  buildPlaceOrderIx,
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
} from "./shared";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const NUM_WALLETS = 5;
const ORDERS_PER_WALLET = 20;
const TOTAL_ORDERS = NUM_WALLETS * ORDERS_PER_WALLET;

/** Delay between individual order submissions (ms) to avoid rate limiting. */
const ORDER_DELAY_MS = 100;

/** SOL to airdrop per test wallet. */
const SOL_PER_WALLET = 2;

/** USDC to mint per test wallet (in USDC lamports, 6 decimals). */
const USDC_PER_WALLET = 500_000_000; // $500

/** Yes/No token pairs to mint per wallet per market (in token lamports, 6 decimals). */
const PAIRS_PER_WALLET_PER_MARKET = 50_000_000; // 50 tokens

const ADMIN_KEYPAIR_PATH = path.resolve(
  process.env.HOME ?? "~",
  ".config/solana/id.json",
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, "..", ".env");

// Side constants matching the on-chain enum
const SIDE_USDC_BID = 0; // Buy Yes (lock USDC)
const SIDE_YES_ASK = 1; // Sell Yes (lock Yes tokens)
const SIDE_NO_BID = 2; // Sell No / Buy Yes via No (lock No tokens)

// Order type constants
const ORDER_TYPE_LIMIT = 1;

// ---------------------------------------------------------------------------
// Market definitions (5 MAG7 markets)
// Each market is identified by ticker + strike price, and the script derives
// today's expiry day automatically to match what create-test-markets.ts uses.
// ---------------------------------------------------------------------------

interface MarketDef {
  ticker: string;
  /** Strike price in USDC lamports */
  strikePriceLamports: bigint;
  /** Previous close in USDC lamports (used only if creating the market) */
  previousCloseLamports: bigint;
}

const MARKET_DEFS: MarketDef[] = [
  { ticker: "AAPL", strikePriceLamports: 200_000_000n, previousCloseLamports: 198_000_000n },
  { ticker: "MSFT", strikePriceLamports: 415_000_000n, previousCloseLamports: 412_000_000n },
  { ticker: "GOOGL", strikePriceLamports: 175_000_000n, previousCloseLamports: 173_000_000n },
  { ticker: "AMZN", strikePriceLamports: 220_000_000n, previousCloseLamports: 218_000_000n },
  { ticker: "NVDA", strikePriceLamports: 140_000_000n, previousCloseLamports: 137_000_000n },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarketAddresses {
  ticker: string;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  escrowVault: PublicKey;
  yesEscrow: PublicKey;
  noEscrow: PublicKey;
  orderBook: PublicKey;
  oracleFeed: PublicKey;
}

interface OrderResult {
  walletIndex: number;
  marketTicker: string;
  side: number;
  price: number;
  quantity: number;
  success: boolean;
  signature?: string;
  error?: string;
  elapsedMs: number;
}

interface LoadTestReport {
  totalOrders: number;
  successful: number;
  failed: number;
  fills: number;
  elapsedMs: number;
  perMarket: Record<string, { attempted: number; succeeded: number }>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { expiryDayBuffer, strikeToBuffer } from "../services/shared/src/pda";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive all PDA addresses for a market. */
function deriveMarketAddresses(
  def: MarketDef,
  marketCloseUnix: number,
): MarketAddresses {
  const tBytes = padTicker(def.ticker);
  const strikeBuf = strikeToBuffer(def.strikePriceLamports);
  const expiryBuf = expiryDayBuffer(marketCloseUnix);

  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), tBytes, strikeBuf, expiryBuf],
    MERIDIAN_PROGRAM_ID,
  );

  const mkSeed = market.toBuffer();

  const [yesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [usdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [escrowVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [yesEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [noEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_escrow"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [orderBook] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_book"), mkSeed],
    MERIDIAN_PROGRAM_ID,
  );
  const [oracleFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), tBytes],
    MOCK_ORACLE_PROGRAM_ID,
  );

  return {
    ticker: def.ticker,
    market,
    yesMint,
    noMint,
    usdcVault,
    escrowVault,
    yesEscrow,
    noEscrow,
    orderBook,
    oracleFeed,
  };
}

/** Read the total_minted field from the on-chain StrikeMarket account. */
async function readMarketTotalMinted(
  connection: Connection,
  marketPda: PublicKey,
): Promise<bigint> {
  const acct = await connection.getAccountInfo(marketPda);
  if (!acct) return 0n;
  const data = Buffer.from(acct.data);
  // Layout after discriminator(8): 9 pubkeys (288 bytes) → total_minted at offset 312
  const OFF_TOTAL_MINTED = 8 + 9 * 32 + 8 + 8; // 312
  const lo = BigInt(data.readUInt32LE(OFF_TOTAL_MINTED));
  const hi = BigInt(data.readUInt32LE(OFF_TOTAL_MINTED + 4));
  return lo + hi * 0x100000000n;
}

/** Read the USDC vault balance in lamports. */
async function readVaultBalance(
  connection: Connection,
  usdcVault: PublicKey,
): Promise<bigint> {
  try {
    const acct = await getAccount(connection, usdcVault);
    return acct.amount;
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Fund wallets
// ---------------------------------------------------------------------------

async function fundWallets(
  connection: Connection,
  admin: Keypair,
  faucetKeypair: Keypair,
  usdcMint: PublicKey,
  wallets: Keypair[],
): Promise<void> {
  console.log(`\n[Step 1] Funding ${wallets.length} wallets with SOL and USDC...`);

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(`  Wallet ${i + 1}: ${wallet.publicKey.toBase58()}`);

    // Airdrop SOL
    const sig = await connection.requestAirdrop(
      wallet.publicKey,
      SOL_PER_WALLET * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`    Airdropped ${SOL_PER_WALLET} SOL`);

    // Create USDC ATA and mint USDC via faucet
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,        // payer for ATA creation
      usdcMint,
      wallet.publicKey,
    );

    await mintTo(
      connection,
      admin,           // payer
      usdcMint,
      ata.address,
      faucetKeypair,   // mint authority
      USDC_PER_WALLET,
    );
    console.log(`    Minted ${USDC_PER_WALLET / 1_000_000} USDC to ${ata.address.toBase58()}`);

    // Small delay to avoid rate limiting
    if (i < wallets.length - 1) await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Verify markets exist
// ---------------------------------------------------------------------------

async function verifyMarkets(
  connection: Connection,
  markets: MarketAddresses[],
): Promise<void> {
  console.log(`\n[Step 2] Verifying ${markets.length} markets exist on-chain...`);

  for (const m of markets) {
    const acct = await connection.getAccountInfo(m.market);
    if (!acct) {
      throw new Error(
        `Market for ${m.ticker} not found at ${m.market.toBase58()}. ` +
        `Run create-test-markets.ts first.`,
      );
    }

    // Check not paused or settled: byte at offset 400 = is_settled, 402 = is_paused
    const data = Buffer.from(acct.data);
    const isSettled = data[400] !== 0;
    const isPaused = data[402] !== 0;
    if (isSettled) {
      throw new Error(`Market ${m.ticker} is already settled. Cannot place orders.`);
    }
    if (isPaused) {
      console.warn(`  WARNING: Market ${m.ticker} is paused. Orders will be rejected.`);
    } else {
      console.log(`  ${m.ticker}: ${m.market.toBase58()} — active`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Mint Yes/No token pairs for each wallet on each market
// ---------------------------------------------------------------------------

async function mintPairsForWallets(
  connection: Connection,
  admin: Keypair,
  usdcMint: PublicKey,
  wallets: Keypair[],
  markets: MarketAddresses[],
): Promise<void> {
  console.log(`\n[Step 3] Minting ${PAIRS_PER_WALLET_PER_MARKET / 1_000_000} Yes/No pairs per wallet per market...`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID,
  );

  const mintPairDisc = anchorDiscriminator("mint_pair");
  const quantityBuf = new BN(PAIRS_PER_WALLET_PER_MARKET).toArrayLike(Buffer, "le", 8);
  const mintPairData = Buffer.concat([mintPairDisc, quantityBuf]);

  for (let wi = 0; wi < wallets.length; wi++) {
    const wallet = wallets[wi];
    const walletUsdcAta = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);

    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi];
      const walletYesAta = getAssociatedTokenAddressSync(m.yesMint, wallet.publicKey);
      const walletNoAta = getAssociatedTokenAddressSync(m.noMint, wallet.publicKey);

      // mint_pair accounts (matches MintPair struct):
      //   user, config, market, yes_mint, no_mint, user_usdc_ata,
      //   user_yes_ata, user_no_ata, usdc_vault,
      //   token_program, associated_token_program, system_program
      const keys = [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: m.market, isSigner: false, isWritable: true },
        { pubkey: m.yesMint, isSigner: false, isWritable: true },
        { pubkey: m.noMint, isSigner: false, isWritable: true },
        { pubkey: walletUsdcAta, isSigner: false, isWritable: true },
        { pubkey: walletYesAta, isSigner: false, isWritable: true },
        { pubkey: walletNoAta, isSigner: false, isWritable: true },
        { pubkey: m.usdcVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const ix = new TransactionInstruction({
        programId: MERIDIAN_PROGRAM_ID,
        keys,
        data: mintPairData,
      });

      const tx = new Transaction().add(ix);
      try {
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
          commitment: "confirmed",
        });
        console.log(`  Wallet ${wi + 1} / ${m.ticker}: minted pairs (sig: ${sig.slice(0, 16)}...)`);
      } catch (err) {
        console.error(`  ERROR minting pairs for wallet ${wi + 1} / ${m.ticker}: ${err}`);
        // Non-fatal: wallet may have insufficient USDC. Continue.
      }

      await sleep(100);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4: Place orders
// ---------------------------------------------------------------------------

/** Submit a single order and record the result. */
async function submitOrder(
  connection: Connection,
  configPda: PublicKey,
  wallet: Keypair,
  walletIndex: number,
  market: MarketAddresses,
  usdcMint: PublicKey,
  side: number,
  price: number,
  quantity: number,
  results: OrderResult[],
  orderCount: { value: number },
  logErrors: boolean,
): Promise<void> {
  const ix = buildPlaceOrderIx(configPda, wallet, market, usdcMint, side, price, quantity);
  const tx = new Transaction().add(ix);

  const startMs = Date.now();
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      commitment: "confirmed",
    });
    const elapsedMs = Date.now() - startMs;
    results.push({
      walletIndex,
      marketTicker: market.ticker,
      side,
      price,
      quantity,
      success: true,
      signature: sig,
      elapsedMs,
    });
    orderCount.value++;

    if (orderCount.value % 10 === 0) {
      console.log(`  Progress: ${orderCount.value}/${TOTAL_ORDERS} orders placed`);
    }
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    results.push({
      walletIndex,
      marketTicker: market.ticker,
      side,
      price,
      quantity,
      success: false,
      error: errMsg,
      elapsedMs,
    });
    orderCount.value++;
    if (logErrors) {
      console.error(`  ERROR (wallet ${walletIndex + 1}, ${market.ticker}, side=${side}, price=${price}): ${errMsg.slice(0, 120)}`);
    }
  }

  await sleep(ORDER_DELAY_MS);
}

async function placeOrders(
  connection: Connection,
  usdcMint: PublicKey,
  wallets: Keypair[],
  markets: MarketAddresses[],
): Promise<OrderResult[]> {
  console.log(`\n[Step 4] Placing ${TOTAL_ORDERS} orders (${ORDERS_PER_WALLET} per wallet)...`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    MERIDIAN_PROGRAM_ID,
  );

  const results: OrderResult[] = [];
  const ordersPerMarketPerWallet = Math.floor(ORDERS_PER_WALLET / markets.length);
  const orderQuantity = 1_000_000;
  const orderCount = { value: 0 };

  for (let wi = 0; wi < wallets.length; wi++) {
    const wallet = wallets[wi];

    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi];

      for (let oi = 0; oi < ordersPerMarketPerWallet; oi++) {
        const sides = [SIDE_USDC_BID, SIDE_YES_ASK, SIDE_NO_BID];
        const side = sides[oi % 3];
        const priceBase = side === SIDE_YES_ASK ? 55 : side === SIDE_NO_BID ? 45 : 50;
        const priceOffset = (oi * 3 + wi) % 15;
        const price = Math.max(1, Math.min(99, priceBase + priceOffset - 7));

        await submitOrder(
          connection, configPda, wallet, wi, m, usdcMint,
          side, price, orderQuantity, results, orderCount, true,
        );
      }
    }

    // Handle remainder orders if ORDERS_PER_WALLET not evenly divisible by market count
    const extraOrders = ORDERS_PER_WALLET - ordersPerMarketPerWallet * markets.length;
    for (let oi = 0; oi < extraOrders; oi++) {
      const m = markets[oi % markets.length];
      const price = 50 + oi;

      await submitOrder(
        connection, configPda, wallet, wi, m, usdcMint,
        SIDE_YES_ASK, price, orderQuantity, results, orderCount, false,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Step 5: Verify vault invariants
// ---------------------------------------------------------------------------

/**
 * For each market, check that vault balance >= total_minted.
 * This is the core invariant: every locked token pair was backed by USDC.
 * Total_minted is denominated in token lamports; vault balance is in USDC lamports.
 * One pair costs 1 USDC = 1_000_000 USDC lamports (6 decimals).
 * So: vault_balance_usdc_lamports >= total_minted_token_lamports is the invariant.
 */
async function verifyVaultInvariants(
  connection: Connection,
  markets: MarketAddresses[],
): Promise<void> {
  console.log("\n[Step 5] Verifying vault invariants (vault_balance >= total_minted)...");

  for (const m of markets) {
    const totalMinted = await readMarketTotalMinted(connection, m.market);
    const vaultBalance = await readVaultBalance(connection, m.usdcVault);

    const ok = vaultBalance >= totalMinted;
    const status = ok ? "PASS" : "FAIL";
    console.log(
      `  [${status}] ${m.ticker}: vault=${vaultBalance} lamports, total_minted=${totalMinted} lamports`,
    );

    if (!ok) {
      console.error(
        `  INVARIANT VIOLATION: vault balance (${vaultBalance}) < total_minted (${totalMinted}) for ${m.ticker}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: Report results
// ---------------------------------------------------------------------------

function buildReport(
  results: OrderResult[],
  startMs: number,
  markets: MarketAddresses[],
): LoadTestReport {
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  // Count fills: a fill occurs when two matching orders clear.
  // We cannot easily count fills from tx signatures without parsing logs,
  // so we report 0 here as a placeholder. In production you'd parse
  // transaction logs for "OrderFilled" events.
  const fills = 0;

  const perMarket: Record<string, { attempted: number; succeeded: number }> = {};
  for (const m of markets) {
    const marketResults = results.filter((r) => r.marketTicker === m.ticker);
    perMarket[m.ticker] = {
      attempted: marketResults.length,
      succeeded: marketResults.filter((r) => r.success).length,
    };
  }

  const errors = results
    .filter((r) => !r.success && r.error)
    .map((r) => `[wallet ${r.walletIndex + 1} / ${r.marketTicker} side=${r.side} price=${r.price}]: ${r.error!.slice(0, 200)}`);

  return {
    totalOrders: results.length,
    successful,
    failed,
    fills,
    elapsedMs: Date.now() - startMs,
    perMarket,
    errors,
  };
}

function printReport(report: LoadTestReport): void {
  const elapsedSec = (report.elapsedMs / 1000).toFixed(1);
  const successRate = report.totalOrders > 0
    ? ((report.successful / report.totalOrders) * 100).toFixed(1)
    : "0.0";

  console.log("\n" + "=".repeat(60));
  console.log("=== Meridian Load Test Report ===");
  console.log("=".repeat(60));
  console.log(`Total orders attempted : ${report.totalOrders}`);
  console.log(`Successful             : ${report.successful} (${successRate}%)`);
  console.log(`Failed                 : ${report.failed}`);
  console.log(`Fills (matched orders) : ${report.fills} (counted via log parsing — not implemented)`);
  console.log(`Time elapsed           : ${elapsedSec}s`);
  console.log("");
  console.log("Per-market breakdown:");
  for (const [ticker, stats] of Object.entries(report.perMarket)) {
    const rate = stats.attempted > 0
      ? ((stats.succeeded / stats.attempted) * 100).toFixed(0)
      : "0";
    console.log(`  ${ticker.padEnd(6)}: ${stats.succeeded}/${stats.attempted} succeeded (${rate}%)`);
  }

  if (report.errors.length > 0) {
    console.log("\nErrors:");
    const showErrors = report.errors.slice(0, 20);
    for (const e of showErrors) {
      console.log(`  - ${e}`);
    }
    if (report.errors.length > 20) {
      console.log(`  ... and ${report.errors.length - 20} more`);
    }
  } else {
    console.log("\nNo errors.");
  }

  console.log("=".repeat(60));

  // Exit non-zero if more than 10% of orders failed
  if (report.failed > 0 && report.failed / report.totalOrders > 0.1) {
    console.error(`\nFAIL: ${report.failed} orders failed (>${10}% threshold)`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scriptStart = Date.now();

  console.log("=== Meridian Load Test ===");
  console.log(`RPC:               ${RPC_URL}`);
  console.log(`Wallets:           ${NUM_WALLETS}`);
  console.log(`Orders per wallet: ${ORDERS_PER_WALLET}`);
  console.log(`Total orders:      ${TOTAL_ORDERS}`);
  console.log(`Markets:           ${MARKET_DEFS.map((m) => m.ticker).join(", ")}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // ── Load admin keypair ─────────────────────────────────────────────────────
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`\nAdmin: ${admin.publicKey.toBase58()}`);

  // ── Read USDC mint and faucet from .env ────────────────────────────────────
  const env = readEnv(ENV_PATH);

  if (!env["USDC_MINT"]) {
    throw new Error("USDC_MINT not found in .env. Run scripts/create-mock-usdc.ts first.");
  }
  const usdcMint = new PublicKey(env["USDC_MINT"]);
  console.log(`USDC Mint: ${usdcMint.toBase58()}`);

  if (!env["FAUCET_KEYPAIR"]) {
    throw new Error("FAUCET_KEYPAIR not found in .env. Run scripts/create-mock-usdc.ts first.");
  }
  const faucetKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env["FAUCET_KEYPAIR"])),
  );
  console.log(`Faucet: ${faucetKeypair.publicKey.toBase58()}`);

  // ── Compute market close unix (shared across all markets for same expiry day) ─
  const marketCloseUnix = todayMarketCloseUnix();
  console.log(`\nMarket close: ${new Date(marketCloseUnix * 1000).toISOString()} (expiry day ${Math.floor(marketCloseUnix / 86400)})`);

  // ── Derive market addresses ────────────────────────────────────────────────
  const markets: MarketAddresses[] = MARKET_DEFS.map((def) =>
    deriveMarketAddresses(def, marketCloseUnix),
  );

  // ── Generate fresh test wallets ────────────────────────────────────────────
  const wallets: Keypair[] = Array.from({ length: NUM_WALLETS }, () =>
    Keypair.generate(),
  );
  console.log(`\nGenerated ${NUM_WALLETS} fresh test wallets:`);
  wallets.forEach((w, i) => console.log(`  Wallet ${i + 1}: ${w.publicKey.toBase58()}`));

  // ── Step 1: Fund wallets ───────────────────────────────────────────────────
  await fundWallets(connection, admin, faucetKeypair, usdcMint, wallets);

  // ── Step 2: Verify markets ─────────────────────────────────────────────────
  await verifyMarkets(connection, markets);

  // ── Step 3: Mint Yes/No pairs ──────────────────────────────────────────────
  await mintPairsForWallets(connection, admin, usdcMint, wallets, markets);

  // ── Step 4: Place orders ───────────────────────────────────────────────────
  const orderStart = Date.now();
  const results = await placeOrders(connection, usdcMint, wallets, markets);
  console.log(`\nOrder placement complete in ${((Date.now() - orderStart) / 1000).toFixed(1)}s`);

  // ── Step 5: Verify vault invariants ───────────────────────────────────────
  await verifyVaultInvariants(connection, markets);

  // ── Step 6: Report ─────────────────────────────────────────────────────────
  const report = buildReport(results, scriptStart, markets);
  printReport(report);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
