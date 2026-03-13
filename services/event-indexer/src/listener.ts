/**
 * Live Event Listener
 *
 * Subscribes to on-chain logs for the Meridian program via
 * `connection.onLogs` and parses Anchor events in real time.
 */

import {
  Connection,
  PublicKey,
  type Logs,
  type Context,
} from "@solana/web3.js";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { createLogger } from "../../shared/src/alerting.ts";
import {
  insertEventsBatch,
  upsertCheckpoint,
  signatureExists,
} from "./db.js";

const log = createLogger("event-indexer:listener");

const EVENT_TYPE_MAP: Record<string, string> = {
  FillEvent: "fill",
  SettlementEvent: "settlement",
  CrankCancelEvent: "crank_cancel",
};

/**
 * Extracts the market pubkey from an event's decoded data.
 * All three Meridian events have a `market` field.
 */
function extractMarket(data: Record<string, unknown>): string {
  const market = data.market;
  if (market && typeof market === "object" && "toBase58" in (market as any)) {
    return (market as any).toBase58();
  }
  return String(market ?? "unknown");
}

/**
 * Extracts a unix-seconds timestamp from event data.
 * FillEvent and SettlementEvent have `timestamp`; CrankCancelEvent does not.
 */
function extractTimestamp(data: Record<string, unknown>): number {
  const ts = data.timestamp;
  if (ts !== undefined && ts !== null) {
    // Anchor BN objects have toNumber()
    if (typeof ts === "object" && "toNumber" in (ts as any)) {
      return (ts as any).toNumber();
    }
    return Number(ts);
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Serialize event data to a JSON-safe object.
 * Converts PublicKey and BN values to strings/numbers.
 */
function serializeEventData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "toBase58" in (value as any)) {
      result[key] = (value as any).toBase58();
    } else if (value && typeof value === "object" && "toNumber" in (value as any)) {
      result[key] = (value as any).toNumber();
    } else if (value instanceof Uint8Array || Array.isArray(value)) {
      // ticker field is [u8; 8] — decode as trimmed UTF-8 string
      if (key === "ticker") {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as number[]);
        result[key] = new TextDecoder().decode(bytes).replace(/\0+$/, "");
      } else {
        result[key] = Array.from(value as Iterable<number>);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface ParsedEvent {
  type: string;
  market: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Parse Anchor events from transaction log messages.
 *
 * Anchor emits events as base64-encoded borsh data after a
 * "Program data: " log prefix. The first 8 bytes are the event
 * discriminator.
 */
export function parseEventsFromLogs(
  coder: BorshCoder,
  logs: string[],
  programId: string,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const PROGRAM_DATA_PREFIX = "Program data: ";

  // Track depth of target program's execution context to handle nested CPI.
  let programDepth = 0;

  for (const line of logs) {
    if (line.includes(`Program ${programId} invoke`)) {
      programDepth++;
      continue;
    }
    if (line.includes(`Program ${programId} success`) || line.includes(`Program ${programId} failed`)) {
      programDepth = Math.max(0, programDepth - 1);
      continue;
    }

    if (programDepth === 0) continue;
    if (!line.includes(PROGRAM_DATA_PREFIX)) continue;

    const dataStr = line.split(PROGRAM_DATA_PREFIX)[1];
    if (!dataStr) continue;

    try {
      const decoded = coder.events.decode(dataStr);
      if (!decoded) continue;

      const typeName = EVENT_TYPE_MAP[decoded.name];
      if (!typeName) continue;

      const data = decoded.data as Record<string, unknown>;
      const serialized = serializeEventData(data);

      events.push({
        type: typeName,
        market: extractMarket(data),
        data: serialized,
        timestamp: extractTimestamp(data),
      });
    } catch {
      // Not every "Program data:" line is an Anchor event — skip silently
    }
  }

  return events;
}

export interface LiveListener {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Create a live event listener instance.
 * Encapsulates subscription state in a closure for multi-instance support.
 */
export function createLiveListener(
  connection: Connection,
  programId: PublicKey,
  idl: Idl,
): LiveListener {
  const coder = new BorshCoder(idl);
  const programIdStr = programId.toBase58();
  let subscriptionId: number | null = null;

  return {
    start(): void {
      if (subscriptionId !== null) {
        log.warn("Live listener already running, ignoring duplicate start");
        return;
      }

      log.info("Starting live event listener", { programId: programIdStr });

      subscriptionId = connection.onLogs(
        programId,
        (logResult: Logs, ctx: Context) => {
          try {
            if (logResult.err) return;

            const { signature, logs: logMessages } = logResult;
            const slot = ctx.slot;

            if (signatureExists(signature)) return;

            const events = parseEventsFromLogs(coder, logMessages, programIdStr);

            // Advance checkpoint for all processed txs, even those with no events,
            // so we don't re-fetch them on restart.
            upsertCheckpoint(signature, slot);

            if (events.length === 0) return;

            // Assign sequence numbers per type+market combo within this tx
            const seqCounters = new Map<string, number>();
            const rows = events.map((event) => {
              const key = `${event.type}:${event.market}`;
              const seq = seqCounters.get(key) ?? 0;
              seqCounters.set(key, seq + 1);
              return {
                type: event.type,
                market: event.market,
                data: JSON.stringify(event.data),
                signature,
                slot,
                timestamp: event.timestamp,
                seq,
              };
            });
            insertEventsBatch(rows);

            log.info(`Indexed ${events.length} event(s) from live tx`, {
              signature: signature.slice(0, 16) + "...",
              slot,
              types: events.map((e) => e.type),
            });
          } catch (err) {
            log.error("Error processing live log event", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        "confirmed",
      );

      log.info("Live listener subscribed", { subscriptionId });
    },

    async stop(): Promise<void> {
      if (subscriptionId !== null) {
        await connection.removeOnLogsListener(subscriptionId);
        log.info("Live listener stopped", { subscriptionId });
        subscriptionId = null;
      }
    },
  };
}

/**
 * Convenience wrappers for backward compatibility.
 * These use a module-level singleton — prefer createLiveListener for new code.
 */
let _defaultListener: LiveListener | null = null;

export function startLiveListener(
  connection: Connection,
  programId: PublicKey,
  idl: Idl,
): void {
  _defaultListener = createLiveListener(connection, programId, idl);
  _defaultListener.start();
}

export async function stopLiveListener(
  connection: Connection,
): Promise<void> {
  if (_defaultListener) {
    await _defaultListener.stop();
    _defaultListener = null;
  }
}
