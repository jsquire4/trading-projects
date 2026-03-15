/**
 * Shared utility functions used across multiple services.
 */

/**
 * Extract a ticker string from the on-chain [u8; 8] byte array,
 * stripping trailing null bytes.
 */
export function tickerFromBytes(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf-8").replace(/\0+$/, "");
}
