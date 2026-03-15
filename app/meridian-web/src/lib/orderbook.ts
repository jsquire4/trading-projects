import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Sparse Order Book layout constants
// ---------------------------------------------------------------------------

const DISC_SIZE = 8;
const PUBKEY_SIZE = 32;

// Header byte offsets (including 8-byte Anchor discriminator)
const HDR_MARKET = 8;           // [8..40]  Pubkey
const HDR_NEXT_ORDER_ID = 40;   // [40..48] u64
const HDR_PRICE_MAP = 48;       // [48..147] [u8; 99]
const HDR_LEVEL_COUNT = 147;    // u8
const HDR_MAX_LEVELS = 148;     // u8
const HDR_ORDERS_PER_LEVEL = 149; // u8
const HEADER_SIZE = 168;

// Level / slot sizes
const LEVEL_HEADER_SIZE = 8;
const ORDER_SLOT_SIZE = 112;

// Slot field offsets
const SLOT_OWNER = 0;
const SLOT_ORDER_ID = 32;
const SLOT_QUANTITY = 40;
const SLOT_ORIG_QTY = 48;
const SLOT_SIDE = 56;
const SLOT_TIMESTAMP = 64;
const SLOT_IS_ACTIVE = 72;

const MAX_PRICE_LEVELS = 99;
const PRICE_UNALLOCATED = 0xFF;

// Side enum values
export const Side = {
  /** USDC bid — buying Yes tokens */
  UsdcBid: 0,
  /** Yes ask — selling Yes tokens */
  YesAsk: 1,
  /** No-backed bid — selling No tokens */
  NoBackedBid: 2,
} as const;

export type SideValue = (typeof Side)[keyof typeof Side];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveOrder {
  owner: PublicKey;
  orderId: bigint;
  quantity: bigint;
  originalQuantity: bigint;
  side: SideValue;
  timestamp: bigint;
  /** 1-based price level index (1 = $0.01, 99 = $0.99) */
  priceLevel: number;
}

export interface DepthLevel {
  /** Price in cents (1–99) */
  price: number;
  /** Total quantity at this price */
  totalQuantity: bigint;
  /** Number of individual orders */
  orderCount: number;
}

export interface OrderBookView {
  bids: DepthLevel[];
  asks: DepthLevel[];
  /** Best bid price in cents, or null if no bids */
  bestBid: number | null;
  /** Best ask price in cents, or null if no asks */
  bestAsk: number | null;
  /** Spread in cents, or null if no two-sided market */
  spread: number | null;
}

export interface DeserializedOrderBook {
  market: PublicKey;
  nextOrderId: bigint;
  orders: ActiveOrder[];
}

// ---------------------------------------------------------------------------
// Deserializer (sparse layout)
// ---------------------------------------------------------------------------

/**
 * Deserialize a sparse OrderBook account buffer into active orders.
 * The sparse layout starts with a 168-byte header containing a price_map[99]
 * that indexes into dynamically allocated levels.
 */
export function deserializeOrderBook(buffer: Buffer): DeserializedOrderBook {
  const data = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  // Market pubkey (32 bytes at offset 8)
  const marketBytes = buffer.subarray(HDR_MARKET, HDR_MARKET + PUBKEY_SIZE);
  const market = new PublicKey(marketBytes);

  // next_order_id (u64 little-endian at offset 40)
  const nextOrderId = data.getBigUint64(HDR_NEXT_ORDER_ID, true);

  const ordersPerLevel = buffer[HDR_ORDERS_PER_LEVEL];
  const entrySize = LEVEL_HEADER_SIZE + ordersPerLevel * ORDER_SLOT_SIZE;
  const orders: ActiveOrder[] = [];

  // Walk price_map to find allocated levels
  for (let priceIdx = 0; priceIdx < MAX_PRICE_LEVELS; priceIdx++) {
    const levelIdx = buffer[HDR_PRICE_MAP + priceIdx];
    if (levelIdx === PRICE_UNALLOCATED) continue;

    const levelBase = HEADER_SIZE + levelIdx * entrySize;
    // Safety: skip if level data extends beyond buffer
    if (levelBase + entrySize > buffer.length) continue;

    const price = priceIdx + 1; // 1-indexed

    // Scan all slots at this level
    for (let s = 0; s < ordersPerLevel; s++) {
      const slotBase = levelBase + LEVEL_HEADER_SIZE + s * ORDER_SLOT_SIZE;

      const isActive = data.getUint8(slotBase + SLOT_IS_ACTIVE);
      if (!isActive) continue;

      const ownerBytes = buffer.subarray(slotBase + SLOT_OWNER, slotBase + SLOT_OWNER + PUBKEY_SIZE);
      const owner = new PublicKey(ownerBytes);
      const orderId = data.getBigUint64(slotBase + SLOT_ORDER_ID, true);
      const quantity = data.getBigUint64(slotBase + SLOT_QUANTITY, true);
      const originalQuantity = data.getBigUint64(slotBase + SLOT_ORIG_QTY, true);
      const side = data.getUint8(slotBase + SLOT_SIDE) as SideValue;
      const timestamp = data.getBigInt64(slotBase + SLOT_TIMESTAMP, true);

      orders.push({
        owner,
        orderId,
        quantity,
        originalQuantity,
        side,
        timestamp,
        priceLevel: price,
      });
    }
  }

  return { market, nextOrderId, orders };
}

// ---------------------------------------------------------------------------
// Depth aggregation helpers
// ---------------------------------------------------------------------------

function aggregateDepth(
  orders: ActiveOrder[],
  side: SideValue | SideValue[],
  priceMapper?: (price: number) => number,
): DepthLevel[] {
  const sides = Array.isArray(side) ? side : [side];
  const depthMap = new Map<number, { totalQuantity: bigint; orderCount: number }>();

  for (const order of orders) {
    if (!sides.includes(order.side)) continue;

    const price = priceMapper
      ? priceMapper(order.priceLevel)
      : order.priceLevel;

    // Skip prices outside valid range after mapping
    if (price < 1 || price > 99) continue;

    const existing = depthMap.get(price);
    if (existing) {
      existing.totalQuantity += order.quantity;
      existing.orderCount += 1;
    } else {
      depthMap.set(price, { totalQuantity: order.quantity, orderCount: 1 });
    }
  }

  const levels: DepthLevel[] = [];
  for (const [price, agg] of depthMap) {
    levels.push({
      price,
      totalQuantity: agg.totalQuantity,
      orderCount: agg.orderCount,
    });
  }

  return levels;
}

function buildView(bids: DepthLevel[], asks: DepthLevel[]): OrderBookView {
  // Sort bids descending by price, asks ascending
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids.length > 0 ? bids[0].price : null;
  const bestAsk = asks.length > 0 ? asks[0].price : null;
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return { bids, asks, bestBid, bestAsk, spread };
}

// ---------------------------------------------------------------------------
// Yes / No views
// ---------------------------------------------------------------------------

/**
 * Build the Yes-token perspective of the order book.
 *
 * - USDC bids (side=0) are Yes bids at their native price
 * - Yes asks (side=1) are Yes asks at their native price
 * - No-backed bids (side=2) are excluded from the Yes view
 */
export function buildYesView(orders: ActiveOrder[]): OrderBookView {
  const bids = aggregateDepth(orders, Side.UsdcBid);
  const asks = aggregateDepth(orders, Side.YesAsk);
  return buildView(bids, asks);
}

/**
 * Build the No-token perspective of the order book.
 *
 * - Yes asks (side=1) at price P appear as No bids at price (100-P)
 *   A Yes seller at P is effectively a No buyer at (100-P).
 * - No-backed bids (side=2) at price P appear as No asks at price P
 *   These are No holders selling at their stated price.
 * - USDC bids (side=0) at price P appear as No asks at price (100-P)
 *   A Yes buyer at P is effectively a No seller at (100-P).
 */
export function buildNoView(orders: ActiveOrder[]): OrderBookView {
  const invert = (p: number) => 100 - p;

  // Yes asks at price P → No bids at (100-P)
  const noBids = aggregateDepth(orders, Side.YesAsk, invert);

  // No-backed bids are native No asks (No holders selling)
  const noNativeAsks = aggregateDepth(orders, Side.NoBackedBid);

  // USDC bids at price P → No asks at (100-P)
  const invertedUsdcAsks = aggregateDepth(orders, Side.UsdcBid, invert);

  // Merge the two ask sources
  const allAsks = mergeDepthLevels([...noNativeAsks, ...invertedUsdcAsks]);

  return buildView(noBids, allAsks);
}

/**
 * Merge depth levels that share the same price after mapping.
 */
function mergeDepthLevels(levels: DepthLevel[]): DepthLevel[] {
  const merged = new Map<number, { totalQuantity: bigint; orderCount: number }>();

  for (const level of levels) {
    const existing = merged.get(level.price);
    if (existing) {
      existing.totalQuantity += level.totalQuantity;
      existing.orderCount += level.orderCount;
    } else {
      merged.set(level.price, {
        totalQuantity: level.totalQuantity,
        orderCount: level.orderCount,
      });
    }
  }

  return Array.from(merged.entries()).map(([price, agg]) => ({
    price,
    totalQuantity: agg.totalQuantity,
    orderCount: agg.orderCount,
  }));
}
