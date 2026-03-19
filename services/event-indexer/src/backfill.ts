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
import { createLogger } from "../../shared/src/alerting.js";
import {
  getCheckpoint,
  insertEventsBatch,
  upsertCheckpoint,
  signatureExists,
  type EventRow,
} from "./db.js";
import { parseEventsFromLogs } from "./listener.js";

const log = createLogger("event-indexer:backfill");

const BATCH_SIZE = 100; // max signatures per getSignaturesForAddress call
const TX_FETCH_CONCURRENCY = 10;

interface BatchResult {
  totalEvents: number;
  failedSigs: ConfirmedSignatureInfo[];
}

/**
 * Fetches a batch of transactions and parses events from their logs.
 * Uses concurrent fetching for throughput. Returns failed sigs for retry.
 */
async function processBatch(
  connection: Connection,
  coder: BorshCoder,
  programIdStr: string,
  signatures: ConfirmedSignatureInfo[],
): Promise<BatchResult> {
  let totalEvents = 0;
  const failedSigs: ConfirmedSignatureInfo[] = [];

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

      if (result.status === "rejected" || !result.value) {
        failedSigs.push(sigInfo);
        continue;
      }

      const tx = result.value;
      if (tx.meta?.err) continue;

      const logMessages = tx.meta?.logMessages ?? [];
      if (logMessages.length === 0) continue;

      // Skip if already indexed
      if (signatureExists(sigInfo.signature)) continue;

      const events = parseEventsFromLogs(coder, logMessages, programIdStr);
      if (events.length === 0) continue;

      // Assign sequence numbers per type+market combo within this tx
      const seqCounters = new Map<string, number>();
      const rows: Omit<EventRow, "id" | "created_at">[] = events.map((event) => {
        const key = `${event.type}:${event.market}`;
        const seq = seqCounters.get(key) ?? 0;
        seqCounters.set(key, seq + 1);
        return {
          type: event.type,
          market: event.market,
          data: JSON.stringify(event.data),
          signature: sigInfo.signature,
          slot: sigInfo.slot,
          timestamp: event.timestamp,
          seq,
        };
      });

      insertEventsBatch(rows);
      totalEvents += rows.length;
    }
  }

  return { totalEvents, failedSigs };
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
  let backfillComplete = false;
  let newestSignature: ConfirmedSignatureInfo | null = null;
  const allFailedSigs: ConfirmedSignatureInfo[] = [];

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
      backfillComplete = true;
      break;
    }

    totalSignatures += signatures.length;
    const { totalEvents: batchEvents, failedSigs } = await processBatch(
      connection,
      coder,
      programIdStr,
      signatures,
    );
    totalEvents += batchEvents;
    allFailedSigs.push(...failedSigs);

    // Track the newest signature across the entire run (first element is the most recent)
    if (!newestSignature) {
      newestSignature = signatures[0];
    }

    // Move cursor backward
    const oldest = signatures[signatures.length - 1];
    before = oldest.signature;

    // If fewer than BATCH_SIZE returned, we've reached the end (or the until point)
    if (signatures.length < BATCH_SIZE) {
      done = true;
      backfillComplete = true;
    }

    log.info(`Backfill batch: ${signatures.length} sigs, ${batchEvents} events`, {
      totalSignatures,
      totalEvents,
      failedCount: failedSigs.length,
    });

    // Incremental checkpoint: persist progress after each batch so a crash
    // doesn't restart from scratch. newestSignature is the most-recent tx
    // seen (set on the first batch), which is where we'd resume from.
    if (newestSignature) {
      upsertCheckpoint(newestSignature.signature, newestSignature.slot);
    }
  }

  // Retry failed signatures once before checkpointing
  if (allFailedSigs.length > 0) {
    log.info(`Retrying ${allFailedSigs.length} failed signature(s)`);
    const { totalEvents: retryEvents, failedSigs: stillFailed } = await processBatch(
      connection,
      coder,
      programIdStr,
      allFailedSigs,
    );
    totalEvents += retryEvents;
    if (stillFailed.length > 0) {
      log.warn(`${stillFailed.length} signature(s) still failed after retry`, {
        sigs: stillFailed.map((s) => s.signature.slice(0, 16) + "..."),
      });
    }
  }

  log.info("Backfill complete", { totalSignatures, totalEvents });

  // Checkpoint only after ALL batches succeed to avoid data gaps on crash
  if (backfillComplete && newestSignature) {
    upsertCheckpoint(newestSignature.signature, newestSignature.slot);
  }
}
