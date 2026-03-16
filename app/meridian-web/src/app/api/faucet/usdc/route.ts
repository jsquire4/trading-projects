import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { mintTo, getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Use server-only env var for RPC (fallback to public var for backwards compat)
const RPC_URL = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
if (!process.env.NEXT_PUBLIC_USDC_MINT) {
  throw new Error("NEXT_PUBLIC_USDC_MINT environment variable is required");
}
const USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT);
const FAUCET_AMOUNT = 1_000 * 1_000_000; // 1000 USDC (6 decimals)

// In-memory rate limit: wallet address -> last served timestamp.
// NOTE: This resets on serverless cold starts (Railway, Vercel). Acceptable for
// devnet/localnet faucet — not a security mechanism, just abuse throttling.
// For production, use Redis or KV-backed rate limiting.
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60_000; // 60 seconds

function parseKeypair(raw: string | undefined): Keypair | null {
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw);
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    return null;
  }
}

function getFaucetKeypair(): Keypair | null {
  // FAUCET_KEYPAIR is the USDC mint authority (created by local-stack.sh)
  // Fall back to ADMIN_KEYPAIR for devnet where admin is also the mint authority
  return parseKeypair(process.env.FAUCET_KEYPAIR) ?? parseKeypair(process.env.ADMIN_KEYPAIR);
}

export async function POST(request: Request) {
  // Guard against mainnet — uses server-side RPC_URL, not browser-exposed NEXT_PUBLIC_
  if (RPC_URL.includes("mainnet")) {
    return NextResponse.json(
      { error: "Faucet is not available on mainnet" },
      { status: 403 },
    );
  }

  const faucet = getFaucetKeypair();
  if (!faucet) {
    return NextResponse.json(
      { error: "Faucet not configured: FAUCET_KEYPAIR or ADMIN_KEYPAIR missing" },
      { status: 500 },
    );
  }

  let wallet: PublicKey;
  try {
    const body = await request.json();
    if (!body.wallet || typeof body.wallet !== "string") {
      return NextResponse.json(
        { error: "Missing wallet address in request body" },
        { status: 400 },
      );
    }
    wallet = new PublicKey(body.wallet);
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  // Rate limit: one request per wallet per 60 seconds
  const walletStr = wallet.toBase58();
  const lastServed = rateLimitMap.get(walletStr);
  if (lastServed && Date.now() - lastServed < RATE_LIMIT_MS) {
    const retryAfter = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastServed)) / 1000);
    return NextResponse.json(
      { error: `Rate limited. Try again in ${retryAfter}s.` },
      { status: 429 },
    );
  }
  rateLimitMap.set(walletStr, Date.now());

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const isDevnet = RPC_URL.includes("devnet");

    // Fund the faucet keypair itself if it has no SOL (needed to pay for txs)
    const faucetBalance = await connection.getBalance(faucet.publicKey);
    if (faucetBalance < 0.05 * 1_000_000_000) {
      try {
        const sig = await connection.requestAirdrop(faucet.publicKey, 2 * 1_000_000_000);
        await connection.confirmTransaction(sig, "confirmed");
      } catch {
        return NextResponse.json(
          { error: "Faucet has no SOL and airdrop failed — is the validator running?" },
          { status: 500 },
        );
      }
    }

    // Airdrop SOL to the user if they have none
    const solBalance = await connection.getBalance(wallet);
    let solAirdropped = false;
    let solAirdropFailed = false;
    if (solBalance < 0.1 * 1_000_000_000) {
      try {
        const airdropSig = await connection.requestAirdrop(wallet, 2 * 1_000_000_000);
        await connection.confirmTransaction(airdropSig, "confirmed");
        solAirdropped = true;
      } catch {
        solAirdropFailed = true;
      }
    }

    // Ensure the user's USDC ATA exists
    const userAta = await getAssociatedTokenAddress(USDC_MINT, wallet);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        faucet.publicKey,
        userAta,
        wallet,
        USDC_MINT,
      ),
    );

    await sendAndConfirmTransaction(connection, tx, [faucet]);

    // Mint test USDC
    const signature = await mintTo(
      connection,
      faucet,
      USDC_MINT,
      userAta,
      faucet, // mint authority
      FAUCET_AMOUNT,
    );

    return NextResponse.json({
      signature,
      amount: FAUCET_AMOUNT / 1_000_000,
      solAirdropped,
      solAirdropFailed,
      isDevnet,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Provide actionable hints for common setup issues
    if (message.includes("could not find mint") || message.includes("Account does not exist")) {
      return NextResponse.json(
        { error: "USDC mint not found on this validator. Run: npx ts-node scripts/create-mock-usdc.ts" },
        { status: 500 },
      );
    }
    if (message.includes("mint authority") || message.includes("owner does not match")) {
      return NextResponse.json(
        { error: "FAUCET_KEYPAIR is not the mint authority for this USDC mint. Re-run create-mock-usdc.ts and update .env.local." },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
