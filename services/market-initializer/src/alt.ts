// ---------------------------------------------------------------------------
// ALT (Address Lookup Table) creation helper
// ---------------------------------------------------------------------------

import {
  AddressLookupTableProgram,
  Connection,
  type Keypair,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export interface MarketAccounts {
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

/**
 * Create and extend an Address Lookup Table with all market-related accounts.
 *
 * Returns the ALT public key once finalized. The ALT needs one slot to
 * activate after creation, so we wait briefly before extending.
 */
export async function createMarketAlt(
  connection: Connection,
  payer: Keypair,
  accounts: MarketAccounts,
): Promise<PublicKey> {
  const recentSlot = await connection.getSlot("finalized");

  // Step 1: Create the ALT
  const [createIx, altAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });

  await sendIxs(connection, payer, [createIx]);

  // Step 2: Extend with all market addresses
  // ALT needs at least 1 slot to become active — wait for a new slot
  const creationSlot = await connection.getSlot("confirmed");
  let currentSlot = creationSlot;
  const maxWaitMs = 30_000;
  const waitStart = Date.now();
  while (currentSlot <= creationSlot) {
    if (Date.now() - waitStart > maxWaitMs) {
      throw new Error(`ALT activation timeout: slot did not advance after ${maxWaitMs}ms`);
    }
    await sleep(400);
    currentSlot = await connection.getSlot("confirmed");
  }

  const addresses = [
    accounts.market,
    accounts.yesMint,
    accounts.noMint,
    accounts.usdcVault,
    accounts.escrowVault,
    accounts.yesEscrow,
    accounts.noEscrow,
    accounts.orderBook,
    accounts.oracleFeed,
    TOKEN_PROGRAM_ID,
    SYSTEM_PROGRAM,
  ];

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: altAddress,
    addresses,
  });

  await sendIxs(connection, payer, [extendIx]);

  return altAddress;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendIxs(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return sig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
