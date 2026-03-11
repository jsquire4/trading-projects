import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANCHOR_DISCRIMINATOR_SIZE = 8;
const PUBKEY_SIZE = 32;

const ORDER_SLOT_SIZE = 80;
const ORDERS_PER_LEVEL = 16;
const PRICE_LEVEL_SIZE = 1288; // 16 * 80 + 1 + 7
const NUM_LEVELS = 99;

// Offsets within the account data (after discriminator)
const MARKET_OFFSET = 0;
const NEXT_ORDER_ID_OFFSET = MARKET_OFFSET + PUBKEY_SIZE; // 32
const LEVELS_OFFSET = NEXT_ORDER_ID_OFFSET + 8; // 40

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
// Deserializer
// ---------------------------------------------------------------------------

/**
 * Deserialize a raw OrderBook account buffer into active orders grouped by
 * price level. Uses DataView for direct binary reads — no Borsh or Anchor
 * deserialization overhead on a 127KB zero-copy account.
 */
export function deserializeOrderBook(buffer: Buffer): DeserializedOrderBook {
  const data = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  // Skip the 8-byte Anchor discriminator
  const base = ANCHOR_DISCRIMINATOR_SIZE;

  // Market pubkey (32 bytes)
  const marketBytes = buffer.subarray(
    base + MARKET_OFFSET,
    base + MARKET_OFFSET + PUBKEY_SIZE,
  );
  const market = new PublicKey(marketBytes);

  // next_order_id (u64 little-endian)
  const nextOrderId = data.getBigUint64(base + NEXT_ORDER_ID_OFFSET, true);

  const orders: ActiveOrder[] = [];

  for (let level = 0; level < NUM_LEVELS; level++) {
    const levelBase = base + LEVELS_OFFSET + level * PRICE_LEVEL_SIZE;

    // count is at offset (16 * 80) = 1280 within the PriceLevel
    const count = data.getUint8(levelBase + ORDERS_PER_LEVEL * ORDER_SLOT_SIZE);

    // Skip empty levels entirely
    if (count === 0) continue;

    // Scan ALL slots, not just 0..count — the on-chain layout is holey.
    // Cancellations and fills deactivate slots in-place without compacting,
    // so active orders can reside in any of the 16 slots.
    for (let slot = 0; slot < ORDERS_PER_LEVEL; slot++) {
      const slotBase = levelBase + slot * ORDER_SLOT_SIZE;

      // is_active: offset 72 within OrderSlot
      const isActive = data.getUint8(slotBase + 72);
      if (!isActive) continue;

      // owner: 32 bytes at offset 0
      const ownerBytes = buffer.subarray(slotBase, slotBase + PUBKEY_SIZE);
      const owner = new PublicKey(ownerBytes);

      // order_id: u64 at offset 32
      const orderId = data.getBigUint64(slotBase + 32, true);

      // quantity: u64 at offset 40
      const quantity = data.getBigUint64(slotBase + 40, true);

      // original_quantity: u64 at offset 48
      const originalQuantity = data.getBigUint64(slotBase + 48, true);

      // side: u8 at offset 56
      const side = data.getUint8(slotBase + 56) as SideValue;

      // timestamp: i64 at offset 64
      const timestamp = data.getBigInt64(slotBase + 64, true);

      orders.push({
        owner,
        orderId,
        quantity,
        originalQuantity,
        side,
        timestamp,
        priceLevel: level + 1, // 1-indexed: level 0 → price 1 cent
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
  // A Yes seller is effectively a No buyer at the complement price
  const noBids = aggregateDepth(orders, Side.YesAsk, invert);

  // No-backed bids are native No asks (No holders selling)
  const noNativeAsks = aggregateDepth(orders, Side.NoBackedBid);

  // USDC bids at price P → No asks at (100-P)
  // A Yes buyer is effectively a No seller at the complement price
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
