/**
 * Historical Backfill
 *
 * On startup, walks backward through transaction history for the
 * program address, parsing events from each transaction's logs.
 * Resumes from the last persisted checkpoint signature.
 */

import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { createLogger } from "../../shared/src/alerting.ts";
import {
  getCheckpoint,
  insertEventsBatch,
  upsertCheckpoint,
  signatureExists,
} from "./db.js";
import { parseEventsFromLogs } from "./listener.js";

const log = createLogger("event-indexer:backfill");

const BATCH_SIZE = 100; // max signatures per getSignaturesForAddress call
const TX_FETCH_CONCURRENCY = 10;

/**
 * Fetches a batch of transactions and parses events from their logs.
 * Uses concurrent fetching for throughput.
 */
async function processBatch(
  connection: Connection,
  coder: BorshCoder,
  programIdStr: string,
  signatures: ConfirmedSignatureInfo[],
): Promise<number> {
  let totalEvents = 0;

  // Process in chunks of TX_FETCH_CONCURRENCY
  for (let i = 0; i < signatures.length; i += TX_FETCH_CONCURRENCY) {
    const chunk = signatures.slice(i, i + TX_FETCH_CONCURRENCY);

    const txResults = await Promise.allSettled(
      chunk.map((sig) =>
        connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }),
      ),
    );

    for (let j = 0; j < txResults.length; j++) {
      const result = txResults[j];
      const sigInfo = chunk[j];

      if (result.status === "rejected" || !result.value) continue;

      const tx = result.value;
      if (tx.meta?.err) continue;

      const logMessages = tx.meta?.logMessages ?? [];
      if (logMessages.length === 0) continue;

      // Skip if already indexed
      if (signatureExists(sigInfo.signature)) continue;

      const events = parseEventsFromLogs(coder, logMessages, programIdStr);
      if (events.length === 0) continue;

      const rows = events.map((event) => ({
        type: event.type,
        market: event.market,
        data: JSON.stringify(event.data),
        signature: sigInfo.signature,
        slot: sigInfo.slot,
        timestamp: event.timestamp,
      }));

      insertEventsBatch(rows);
      totalEvents += rows.length;
    }
  }

  return totalEvents;
}

/**
 * Run the backfill process.
 *
 * Walks backward through signatures from newest to the checkpoint.
 * If no checkpoint exists, fetches all available history.
 */
export async function runBackfill(
  connection: Connection,
  programId: PublicKey,
  idl: Idl,
): Promise<void> {
  const coder = new BorshCoder(idl);
  const programIdStr = programId.toBase58();
  const checkpoint = getCheckpoint();

  log.info("Starting backfill", {
    programId: programIdStr,
    checkpoint: checkpoint
      ? { sig: checkpoint.last_signature.slice(0, 16) + "...", slot: checkpoint.last_slot }
      : null,
  });

  let totalEvents = 0;
  let totalSignatures = 0;
  let before: string | undefined;
  let done = false;

  while (!done) {
    const opts: { limit: number; before?: string; until?: string } = {
      limit: BATCH_SIZE,
    };
    if (before) opts.before = before;
    if (checkpoint) opts.until = checkpoint.last_signature;

    let signatures: ConfirmedSignatureInfo[];
    try {
      signatures = await connection.getSignaturesForAddress(programId, opts);
    } catch (err) {
      log.error("Failed to fetch signatures", {
        error: String(err),
      });
      break;
    }

    if (signatures.length === 0) {
      done = true;
      break;
    }

    totalSignatures += signatures.length;
    const batchEvents = await processBatch(
      connection,
      coder,
      programIdStr,
      signatures,
    );
    totalEvents += batchEvents;

    // Update checkpoint to the newest signature we've processed in this run
    // (first element is the most recent)
    const newest = signatures[0];
    upsertCheckpoint(newest.signature, newest.slot);

    // Move cursor backward
    const oldest = signatures[signatures.length - 1];
    before = oldest.signature;

    // If fewer than BATCH_SIZE returned, we've reached the end (or the until point)
    if (signatures.length < BATCH_SIZE) {
      done = true;
    }

    log.info(`Backfill batch: ${signatures.length} sigs, ${batchEvents} events`, {
      totalSignatures,
      totalEvents,
    });
  }

  log.info("Backfill complete", { totalSignatures, totalEvents });
}
