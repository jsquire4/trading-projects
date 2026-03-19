import { Connection, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import BN from "bn.js";

async function main() {
  const c = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf8"))));
  const MOCK_ORACLE = new PublicKey("Az6BVaQwfoSqDyyn3TyvgfavoVKN4Qm8wLbMWm5EceFC");
  const MERIDIAN = new PublicKey("G5zZw1GMzqwjfbRMjTi2qUXDwoUwLw83hjEuwLfVCZvy");

  const ticker = Buffer.alloc(8, 0);
  Buffer.from("F").copy(ticker);
  const [feedPda] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), ticker], MOCK_ORACLE);

  // 1. Register ticker
  console.log("Registering F in ticker registry...");
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN);
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("tickers")], MERIDIAN);
  const disc3 = createHash("sha256").update("global:add_ticker").digest().subarray(0, 8);
  const tx3 = new Transaction().add(new TransactionInstruction({
    programId: MERIDIAN,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc3, ticker]),
  }));
  try {
    const sig3 = await sendAndConfirmTransaction(c, tx3, [admin]);
    console.log("Registered:", sig3);
  } catch (e: any) {
    if (e.message?.includes("TickerAlreadyExists")) console.log("Already registered");
    else throw e;
  }

  // 2. Create oracle feed
  console.log("Creating oracle feed for F at", feedPda.toBase58());
  const disc = createHash("sha256").update("global:initialize_feed").digest().subarray(0, 8);
  const tx = new Transaction().add(new TransactionInstruction({
    programId: MOCK_ORACLE,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: feedPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, ticker]),
  }));
  try {
    const sig = await sendAndConfirmTransaction(c, tx, [admin]);
    console.log("Feed created:", sig);
  } catch (e: any) {
    if (e.message?.includes("already in use")) console.log("Feed already exists");
    else throw e;
  }

  // 3. Update price
  console.log("Setting F price to $10.50...");
  const disc2 = createHash("sha256").update("global:update_price").digest().subarray(0, 8);
  const price = new BN(10_500_000);
  const conf = new BN(10_500);
  const ts = new BN(Math.floor(Date.now() / 1000) - 30); // Subtract 30s to stay behind cluster clock
  const tx2 = new Transaction().add(new TransactionInstruction({
    programId: MOCK_ORACLE,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: feedPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc2, price.toArrayLike(Buffer, "le", 8), conf.toArrayLike(Buffer, "le", 8), ts.toArrayLike(Buffer, "le", 8)]),
  }));
  const sig2 = await sendAndConfirmTransaction(c, tx2, [admin]);
  console.log("Price set:", sig2);
  console.log("Done! F is ready.");
}

main().catch(console.error);
