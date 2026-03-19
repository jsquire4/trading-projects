/**
 * Order book binary parser — shared by AMM bot, e2e tests, and scripts.
 *
 * Parses the sparse order book layout directly from raw account bytes,
 * bypassing Anchor's auto-deserialization which doesn't handle the
 * variable-size level array correctly.
 */

import { PublicKey } from "@solana/web3.js";

export interface ParsedOrder {
  priceLevel: number; // 1-99
  slotIndex: number;
  owner: PublicKey;
  orderId: bigint;
  quantity: bigint;
  side: number; // 0=UsdcBid, 1=YesAsk, 2=NoBid
  isActive: boolean;
}

// Order book header layout constants
const SLOT_SIZE = 112;
const LEVEL_HEADER_SIZE = 8;
const PRICE_MAP_OFFSET = 48;
const PRICE_MAP_LEN = 99;
const UNALLOCATED = 0xffff;

/**
 * Parse all active orders from a raw order book account buffer.
 *
 * Price map entries are u16 LE at [48..246] — each stores the **absolute
 * byte offset** from the start of the account data where that price
 * level begins. A value of 0xFFFF means unallocated.
 */
export function parseOrderBook(data: Buffer): ParsedOrder[] {
  // Minimum valid size: header must contain price_map (48 + 99*2 = 246 bytes)
  const MIN_BUFFER_SIZE = PRICE_MAP_OFFSET + PRICE_MAP_LEN * 2;
  if (data.length < MIN_BUFFER_SIZE) return [];

  const orders: ParsedOrder[] = [];

  for (let priceIdx = 0; priceIdx < PRICE_MAP_LEN; priceIdx++) {
    const levelOffset = data.readUInt16LE(PRICE_MAP_OFFSET + priceIdx * 2);
    if (levelOffset === UNALLOCATED) continue;

    // levelOffset is absolute — no HEADER_SIZE addition needed
    if (levelOffset + LEVEL_HEADER_SIZE > data.length) continue;

    const activeCount = data[levelOffset + 1];
    if (activeCount === 0) continue;

    const slotCount = data[levelOffset + 2];

    for (let s = 0; s < slotCount; s++) {
      const slotOffset = levelOffset + LEVEL_HEADER_SIZE + s * SLOT_SIZE;
      if (slotOffset + SLOT_SIZE > data.length) break;

      const isActive = data[slotOffset + 72] !== 0;
      if (!isActive) continue;

      const owner = new PublicKey(data.subarray(slotOffset, slotOffset + 32));
      const orderId = data.readBigUInt64LE(slotOffset + 32);
      const quantity = data.readBigUInt64LE(slotOffset + 40);
      const side = data[slotOffset + 56];

      orders.push({
        priceLevel: priceIdx + 1,
        slotIndex: s,
        owner,
        orderId,
        quantity,
        side,
        isActive: true,
      });
    }
  }
  return orders;
}
