/**
 * orderbook-layout.ts — Sparse orderbook layout constants and helpers
 * for reading on-chain OrderBook data in tests.
 *
 * Matches the Rust sparse layout in state/order_book.rs.
 * Variable-size levels: price_map stores u16 byte offsets, each level
 * has its own slot_count.
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ---------------------------------------------------------------------------
// Sparse Order Book layout constants
// ---------------------------------------------------------------------------

export const OB_DISCRIMINATOR_SIZE = 8;
export const ORDER_SLOT_SIZE = 112;
export const LEVEL_HEADER_SIZE = 8;
export const MAX_PRICE_LEVELS = 99;
export const PRICE_UNALLOCATED = 0xFFFF;

// Header byte offsets (including 8-byte Anchor discriminator)
// Price map is [u16; 99] = 198 bytes (stores byte offsets, 0xFFFF = unallocated)
export const HDR_MARKET = 8;           // [8..40]  Pubkey
export const HDR_NEXT_ORDER_ID = 40;   // [40..48] u64
export const HDR_PRICE_MAP = 48;       // [48..246] [u16 LE; 99]
export const HDR_LEVEL_COUNT = 246;    // [246] u8
export const HDR_MAX_LEVELS = 247;     // [247] u8
export const HDR_BUMP = 248;           // [248] u8
export const HEADER_SIZE = 270;        // Total header including discriminator

// Level header offsets (relative to level start)
export const LVL_PRICE = 0;
export const LVL_ACTIVE_COUNT = 1;
export const LVL_SLOT_COUNT = 2;

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
// Price map helpers (u16 byte offsets)
// ---------------------------------------------------------------------------

/** Read the byte offset for a price (1-99) from the price map. Returns PRICE_UNALLOCATED if not set. */
export function priceLevelOffset(data: Buffer, price: number): number {
  const idx = HDR_PRICE_MAP + (price - 1) * 2;
  return data.readUInt16LE(idx);
}

/** Read the slot_count for a level at the given byte offset. */
export function levelSlotCount(data: Buffer, loff: number): number {
  return data[loff + LVL_SLOT_COUNT];
}

/** Read the active order count at a level byte offset. */
export function readLevelCount(data: Buffer, loff: number): number {
  return data[loff + LVL_ACTIVE_COUNT];
}

/** Compute the byte offset of a specific slot within a level. */
export function slotOffsetAt(loff: number, slotIdx: number): number {
  return loff + LEVEL_HEADER_SIZE + slotIdx * ORDER_SLOT_SIZE;
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
  loff: number,
  slotIdx: number,
): OrderSlot {
  const offset = slotOffsetAt(loff, slotIdx);
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
// Sparse book initialization helper (for bankrun tests)
// ---------------------------------------------------------------------------

/**
 * Create a pre-initialized sparse order book buffer for bankrun tests.
 * Returns a Buffer of HEADER_SIZE (270) bytes with discriminator and price_map set.
 */
export function createSparseBookBuffer(marketKey: PublicKey, bump: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE, 0);
  // Discriminator
  sparseBookDiscriminator().copy(buf, 0);
  // Market key
  marketKey.toBuffer().copy(buf, HDR_MARKET);
  // next_order_id = 0 (already zeroed)
  // price_map: all unallocated (u16 0xFFFF each)
  for (let p = 0; p < MAX_PRICE_LEVELS; p++) {
    buf.writeUInt16LE(PRICE_UNALLOCATED, HDR_PRICE_MAP + p * 2);
  }
  // level_count = 0
  buf[HDR_LEVEL_COUNT] = 0;
  // max_levels = 0
  buf[HDR_MAX_LEVELS] = 0;
  // bump
  buf[HDR_BUMP] = bump;
  return buf;
}

// ---------------------------------------------------------------------------
// Active orders scanner
// ---------------------------------------------------------------------------

/**
 * Scan the sparse order book for all active orders.
 * Returns an array of { price, slotIdx, slot } objects.
 */
export function findActiveOrders(data: Buffer): Array<{
  price: number;
  slotIdx: number;
  slot: OrderSlot;
}> {
  const result: Array<{ price: number; slotIdx: number; slot: OrderSlot }> = [];

  for (let priceIdx = 0; priceIdx < MAX_PRICE_LEVELS; priceIdx++) {
    const price = priceIdx + 1;
    const loff = priceLevelOffset(data, price);
    if (loff === PRICE_UNALLOCATED) continue;

    const slotCnt = levelSlotCount(data, loff);
    for (let s = 0; s < slotCnt; s++) {
      const off = slotOffsetAt(loff, s);
      if (off + ORDER_SLOT_SIZE > data.length) break;
      if (data[off + SLOT_IS_ACTIVE] !== 0) {
        result.push({
          price,
          slotIdx: s,
          slot: readOrderSlot(data, loff, s),
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Backward-compat aliases (deprecated — use new names)
// ---------------------------------------------------------------------------

/** @deprecated Use priceLevelOffset instead */
export function priceLevelIdx(data: Buffer, price: number): number {
  return priceLevelOffset(data, price);
}
