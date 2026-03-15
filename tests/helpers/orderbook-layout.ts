/**
 * orderbook-layout.ts — Sparse orderbook layout constants and helpers
 * for reading on-chain OrderBook data in tests.
 *
 * Matches the Rust sparse layout in state/order_book.rs.
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ---------------------------------------------------------------------------
// Sparse Order Book layout constants
// ---------------------------------------------------------------------------

export const OB_DISCRIMINATOR_SIZE = 8;
export const ORDER_SLOT_SIZE = 112;
export const LEVEL_HEADER_SIZE = 8;
export const INITIAL_ORDERS_PER_LEVEL = 4;
export const MAX_PRICE_LEVELS = 99;
export const PRICE_UNALLOCATED = 0xFF;

// Header byte offsets (including 8-byte Anchor discriminator)
export const HDR_MARKET = 8;           // [8..40]  Pubkey
export const HDR_NEXT_ORDER_ID = 40;   // [40..48] u64
export const HDR_PRICE_MAP = 48;       // [48..147] [u8; 99]
export const HDR_LEVEL_COUNT = 147;    // [147] u8
export const HDR_MAX_LEVELS = 148;     // [148] u8
export const HDR_ORDERS_PER_LEVEL = 149; // [149] u8
export const HDR_BUMP = 150;           // [150] u8
export const HEADER_SIZE = 168;        // Total header including discriminator

// Order slot field offsets within a slot
export const SLOT_OWNER = 0;           // [0..32]  Pubkey
export const SLOT_ORDER_ID = 32;       // [32..40] u64
export const SLOT_QUANTITY = 40;       // [40..48] u64
export const SLOT_ORIG_QTY = 48;       // [48..56] u64
export const SLOT_SIDE = 56;           // [56] u8
export const SLOT_TIMESTAMP = 64;      // [64..72] i64
export const SLOT_IS_ACTIVE = 72;      // [72] u8
export const SLOT_RENT_DEPOSITOR = 80; // [80..112] Pubkey

// Side constants
export const SIDE_USDC_BID = 0;
export const SIDE_YES_ASK = 1;
export const SIDE_NO_BID = 2;

// Order type constants
export const ORDER_TYPE_MARKET = 0;
export const ORDER_TYPE_LIMIT = 1;

// ---------------------------------------------------------------------------
// Sparse book discriminator (matches Rust `account:OrderBook` hash)
// ---------------------------------------------------------------------------

import { createHash } from "crypto";

export function sparseBookDiscriminator(): Buffer {
  const hash = createHash("sha256").update("account:OrderBook").digest();
  return hash.subarray(0, 8);
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

/** Compute the byte offset of level `idx` within account data. */
export function levelOffset(ordersPerLevel: number, idx: number): number {
  const entrySize = LEVEL_HEADER_SIZE + ordersPerLevel * ORDER_SLOT_SIZE;
  return HEADER_SIZE + idx * entrySize;
}

/** Compute the byte offset of a specific order slot. */
export function slotOffset(ordersPerLevel: number, levelIdx: number, slotIdx: number): number {
  return levelOffset(ordersPerLevel, levelIdx) + LEVEL_HEADER_SIZE + slotIdx * ORDER_SLOT_SIZE;
}

/** Compute total account size for given level count and orders per level. */
export function accountSize(levelCount: number, ordersPerLevel: number): number {
  const entrySize = LEVEL_HEADER_SIZE + ordersPerLevel * ORDER_SLOT_SIZE;
  return HEADER_SIZE + levelCount * entrySize;
}

// ---------------------------------------------------------------------------
// Order slot reader
// ---------------------------------------------------------------------------

export interface OrderSlot {
  owner: PublicKey;
  orderId: number;
  quantity: number;
  originalQuantity: number;
  side: number;
  timestamp: number;
  isActive: boolean;
  rentDepositor: PublicKey;
}

/**
 * Read a single order slot from raw sparse OrderBook data.
 */
export function readOrderSlot(
  data: Buffer,
  levelIdx: number,
  slotIdx: number,
): OrderSlot {
  const opl = data[HDR_ORDERS_PER_LEVEL];
  const offset = slotOffset(opl, levelIdx, slotIdx);
  const owner = new PublicKey(data.subarray(offset + SLOT_OWNER, offset + SLOT_OWNER + 32));
  const orderId = new BN(data.subarray(offset + SLOT_ORDER_ID, offset + SLOT_ORDER_ID + 8), "le").toNumber();
  const quantity = new BN(data.subarray(offset + SLOT_QUANTITY, offset + SLOT_QUANTITY + 8), "le").toNumber();
  const originalQuantity = new BN(data.subarray(offset + SLOT_ORIG_QTY, offset + SLOT_ORIG_QTY + 8), "le").toNumber();
  const side = data[offset + SLOT_SIDE];
  const timestamp = new BN(data.subarray(offset + SLOT_TIMESTAMP, offset + SLOT_TIMESTAMP + 8), "le").toNumber();
  const isActive = data[offset + SLOT_IS_ACTIVE] !== 0;
  const rentDepositor = new PublicKey(data.subarray(offset + SLOT_RENT_DEPOSITOR, offset + SLOT_RENT_DEPOSITOR + 32));
  return { owner, orderId, quantity, originalQuantity, side, timestamp, isActive, rentDepositor };
}

// ---------------------------------------------------------------------------
// Price map lookup
// ---------------------------------------------------------------------------

/**
 * Look up the level index for a given price (1-99) from the sparse price_map.
 * Returns the level index, or PRICE_UNALLOCATED (0xFF) if not allocated.
 */
export function priceLevelIdx(data: Buffer, price: number): number {
  return data[HDR_PRICE_MAP + (price - 1)];
}

// ---------------------------------------------------------------------------
// Level count reader
// ---------------------------------------------------------------------------

/**
 * Read the active order count at a level index.
 */
export function readLevelCount(data: Buffer, levelIdx: number): number {
  const opl = data[HDR_ORDERS_PER_LEVEL];
  const off = levelOffset(opl, levelIdx) + 1; // price(1) + count(1)
  return data[off];
}

// ---------------------------------------------------------------------------
// Sparse book initialization helper (for bankrun tests)
// ---------------------------------------------------------------------------

/**
 * Create a pre-initialized sparse order book buffer for bankrun tests.
 * Returns a Buffer of HEADER_SIZE (168) bytes with discriminator and price_map set.
 */
export function createSparseBookBuffer(marketKey: PublicKey, bump: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE, 0);
  // Discriminator
  sparseBookDiscriminator().copy(buf, 0);
  // Market key
  marketKey.toBuffer().copy(buf, HDR_MARKET);
  // next_order_id = 0 (already zeroed)
  // price_map: all unallocated
  buf.fill(PRICE_UNALLOCATED, HDR_PRICE_MAP, HDR_PRICE_MAP + MAX_PRICE_LEVELS);
  // level_count = 0
  buf[HDR_LEVEL_COUNT] = 0;
  // max_levels = 0
  buf[HDR_MAX_LEVELS] = 0;
  // orders_per_level = INITIAL_ORDERS_PER_LEVEL
  buf[HDR_ORDERS_PER_LEVEL] = INITIAL_ORDERS_PER_LEVEL;
  // bump
  buf[HDR_BUMP] = bump;
  return buf;
}

// ---------------------------------------------------------------------------
// Active orders scanner
// ---------------------------------------------------------------------------

/**
 * Scan the sparse order book for all active orders.
 * Returns an array of { levelIdx, slotIdx, slot } objects.
 */
export function findActiveOrders(data: Buffer): Array<{
  levelIdx: number;
  slotIdx: number;
  slot: OrderSlot;
}> {
  const result: Array<{ levelIdx: number; slotIdx: number; slot: OrderSlot }> = [];
  const opl = data[HDR_ORDERS_PER_LEVEL];

  for (let priceIdx = 0; priceIdx < MAX_PRICE_LEVELS; priceIdx++) {
    const levelIdx = data[HDR_PRICE_MAP + priceIdx];
    if (levelIdx === PRICE_UNALLOCATED) continue;

    for (let s = 0; s < opl; s++) {
      const off = slotOffset(opl, levelIdx, s);
      if (off + ORDER_SLOT_SIZE > data.length) break;
      if (data[off + SLOT_IS_ACTIVE] !== 0) {
        result.push({
          levelIdx,
          slotIdx: s,
          slot: readOrderSlot(data, levelIdx, s),
        });
      }
    }
  }

  return result;
}
