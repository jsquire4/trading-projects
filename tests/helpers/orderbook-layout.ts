/**
 * orderbook-layout.ts — Canonical orderbook layout constants and helpers
 * for reading on-chain OrderBook data in tests.
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ---------------------------------------------------------------------------
// OrderBook layout constants
// ---------------------------------------------------------------------------

export const OB_DISCRIMINATOR_SIZE = 8;
export const OB_ORDER_SLOT_SIZE = 80;
export const OB_PRICE_LEVEL_SIZE = 2568;
/** Offset to the first price level: discriminator(8) + market_key(32) + next_order_id(8) = 48 */
export const OB_LEVELS_OFFSET = OB_DISCRIMINATOR_SIZE + 32 + 8; // 48

// Side constants
export const SIDE_USDC_BID = 0;
export const SIDE_YES_ASK = 1;
export const SIDE_NO_BID = 2;

// Order type constants
export const ORDER_TYPE_MARKET = 0;
export const ORDER_TYPE_LIMIT = 1;

// ---------------------------------------------------------------------------
// Order slot reader (full version with all fields)
// ---------------------------------------------------------------------------

export interface OrderSlot {
  owner: PublicKey;
  orderId: number;
  quantity: number;
  originalQuantity: number;
  side: number;
  timestamp: number;
  isActive: boolean;
}

/**
 * Read a single order slot from raw OrderBook data.
 *
 * @param data      Raw account data buffer
 * @param levelIdx  Price level index (0-based)
 * @param slotIdx   Slot index within the level (0-31)
 */
export function readOrderSlot(
  data: Buffer,
  levelIdx: number,
  slotIdx: number,
): OrderSlot {
  const offset =
    OB_LEVELS_OFFSET +
    levelIdx * OB_PRICE_LEVEL_SIZE +
    slotIdx * OB_ORDER_SLOT_SIZE;
  const owner = new PublicKey(data.subarray(offset, offset + 32));
  const orderId = new BN(
    data.subarray(offset + 32, offset + 40),
    "le",
  ).toNumber();
  const quantity = new BN(
    data.subarray(offset + 40, offset + 48),
    "le",
  ).toNumber();
  const originalQuantity = new BN(
    data.subarray(offset + 48, offset + 56),
    "le",
  ).toNumber();
  const side = data[offset + 56];
  const timestamp = new BN(
    data.subarray(offset + 64, offset + 72),
    "le",
  ).toNumber();
  const isActive = data[offset + 72] !== 0;
  return { owner, orderId, quantity, originalQuantity, side, timestamp, isActive };
}

// ---------------------------------------------------------------------------
// Level count reader
// ---------------------------------------------------------------------------

/**
 * Read the order count for a price level.
 * Count byte is located after the 32 order slots at the end of each level.
 */
export function readLevelCount(data: Buffer, levelIdx: number): number {
  const countOffset =
    OB_LEVELS_OFFSET +
    levelIdx * OB_PRICE_LEVEL_SIZE +
    32 * OB_ORDER_SLOT_SIZE;
  return data[countOffset];
}
