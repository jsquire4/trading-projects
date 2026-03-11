import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { mintTo, getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Use server-only env var for RPC (fallback to public var for backwards compat)
const RPC_URL = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT ?? PublicKey.default.toBase58());
const FAUCET_AMOUNT = 1_000 * 1_000_000; // 1000 USDC (6 decimals)

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

  try {
    const connection = new Connection(RPC_URL, "confirmed");

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

    return NextResponse.json({ signature, amount: FAUCET_AMOUNT / 1_000_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
