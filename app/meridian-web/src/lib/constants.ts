/**
 * Shared constants and tiny helpers used across multiple frontend files.
 *
 * Centralizes EVENT_INDEXER_URL, side label/color maps, and the BN-to-BigInt
 * converter so they aren't duplicated in every consumer.
 */

// ---------------------------------------------------------------------------
// Event indexer base URL (server-side & client-side)
// ---------------------------------------------------------------------------

export const EVENT_INDEXER_URL =
  process.env.NEXT_PUBLIC_EVENT_INDEXER_URL ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// Order side display maps
// ---------------------------------------------------------------------------

/** On-chain side → human-readable label. */
export const SIDE_LABELS: Record<number, string> = {
  0: "Buy Yes",
  1: "Sell Yes",
  2: "Sell No",
};

/** On-chain side → Tailwind text color class. */
export const SIDE_COLORS: Record<number, string> = {
  0: "text-green-400",
  1: "text-amber-400",
  2: "text-red-400",
};

// ---------------------------------------------------------------------------
// Anchor BN → native BigInt
// ---------------------------------------------------------------------------

/**
 * Convert an Anchor BN-like value to a native BigInt.
 *
 * Anchor's coder returns BN objects for u64/i64 fields. Calling `.toString()`
 * is the safest cross-version way to extract the value.
 */
export function toBigInt(v: unknown): bigint {
  return BigInt((v as { toString(): string })?.toString() ?? "0");
}
