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

// In-memory rate limit: wallet address -> last served timestamp
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

    // Airdrop SOL if the user has none (local validator and devnet support requestAirdrop)
    const solBalance = await connection.getBalance(wallet);
    let solAirdropped = false;
    let solAirdropFailed = false;
    const isDevnet = RPC_URL.includes("devnet");
    if (solBalance < 0.1 * 1_000_000_000) {
      try {
        const airdropSig = await connection.requestAirdrop(wallet, 2 * 1_000_000_000); // 2 SOL
        await connection.confirmTransaction(airdropSig, "confirmed");
        solAirdropped = true;
      } catch {
        // Devnet rate-limits SOL airdrops.
        // Local validator has unlimited airdrops — this typically only fails on devnet.
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
