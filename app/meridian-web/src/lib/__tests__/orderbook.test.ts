import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  deserializeOrderBook,
  buildYesView,
  buildNoView,
  Side,
  type ActiveOrder,
} from "../orderbook";

// ---------------------------------------------------------------------------
// Helpers to build mock buffers matching the on-chain layout
// ---------------------------------------------------------------------------

const ANCHOR_DISCRIMINATOR_SIZE = 8;
const PUBKEY_SIZE = 32;
const ORDER_SLOT_SIZE = 80;
const ORDERS_PER_LEVEL = 16;
const PRICE_LEVEL_SIZE = 1288; // 16 * 80 + 1 + 7
const NUM_LEVELS = 99;

const TOTAL_SIZE =
  ANCHOR_DISCRIMINATOR_SIZE + // discriminator
  PUBKEY_SIZE + // market pubkey
  8 + // next_order_id (u64)
  NUM_LEVELS * PRICE_LEVEL_SIZE; // price levels

function createEmptyBuffer(): Buffer {
  return Buffer.alloc(TOTAL_SIZE);
}

/** Write an order slot into the buffer at the given price level and slot index. */
function writeOrder(
  buf: Buffer,
  priceLevel: number, // 1-based (1..99)
  slotIndex: number,
  opts: {
    owner?: Buffer;
    orderId?: bigint;
    quantity?: bigint;
    originalQuantity?: bigint;
    side?: number;
    timestamp?: bigint;
    isActive?: boolean;
  },
) {
  const levelIdx = priceLevel - 1; // 0-based
  const levelBase =
    ANCHOR_DISCRIMINATOR_SIZE + PUBKEY_SIZE + 8 + levelIdx * PRICE_LEVEL_SIZE;
  const slotBase = levelBase + slotIndex * ORDER_SLOT_SIZE;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // owner (32 bytes)
  const owner = opts.owner ?? Buffer.alloc(PUBKEY_SIZE, 1);
  owner.copy(buf, slotBase, 0, PUBKEY_SIZE);

  // order_id (u64 LE at offset 32)
  dv.setBigUint64(slotBase + 32, opts.orderId ?? 1n, true);

  // quantity (u64 LE at offset 40)
  dv.setBigUint64(slotBase + 40, opts.quantity ?? 100n, true);

  // original_quantity (u64 LE at offset 48)
  dv.setBigUint64(slotBase + 48, opts.originalQuantity ?? 100n, true);

  // side (u8 at offset 56)
  dv.setUint8(slotBase + 56, opts.side ?? Side.UsdcBid);

  // timestamp (i64 LE at offset 64)
  dv.setBigInt64(slotBase + 64, opts.timestamp ?? 1700000000n, true);

  // is_active (u8 at offset 72)
  dv.setUint8(slotBase + 72, opts.isActive !== false ? 1 : 0);

  // Update the count at the end of the price level (offset 16*80 = 1280)
  const countOffset = levelBase + ORDERS_PER_LEVEL * ORDER_SLOT_SIZE;
  const currentCount = dv.getUint8(countOffset);
  if (slotIndex >= currentCount) {
    dv.setUint8(countOffset, slotIndex + 1);
  }
}

function setMarketPubkey(buf: Buffer, pubkey: PublicKey) {
  const bytes = pubkey.toBuffer();
  bytes.copy(buf, ANCHOR_DISCRIMINATOR_SIZE);
}

function setNextOrderId(buf: Buffer, id: bigint) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(ANCHOR_DISCRIMINATOR_SIZE + PUBKEY_SIZE, id, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deserializeOrderBook", () => {
  it("returns empty orders for an empty book", () => {
    const buf = createEmptyBuffer();
    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(0);
  });

  it("returns only active orders, skips inactive", () => {
    const buf = createEmptyBuffer();

    // Active order at price level 50, slot 0
    writeOrder(buf, 50, 0, { orderId: 1n, isActive: true });
    // Inactive order at price level 50, slot 1
    writeOrder(buf, 50, 1, { orderId: 2n, isActive: false });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].orderId).toBe(1n);
    expect(result.orders[0].priceLevel).toBe(50);
  });

  it("reads market pubkey and nextOrderId correctly", () => {
    const buf = createEmptyBuffer();
    const marketKey = PublicKey.unique();
    setMarketPubkey(buf, marketKey);
    setNextOrderId(buf, 42n);

    const result = deserializeOrderBook(buf);
    expect(result.market.equals(marketKey)).toBe(true);
    expect(result.nextOrderId).toBe(42n);
  });

  it("reads all order fields correctly", () => {
    const buf = createEmptyBuffer();
    const ownerBuf = PublicKey.unique().toBuffer();
    writeOrder(buf, 25, 0, {
      owner: ownerBuf,
      orderId: 7n,
      quantity: 500n,
      originalQuantity: 1000n,
      side: Side.YesAsk,
      timestamp: 1700000123n,
      isActive: true,
    });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(1);
    const order = result.orders[0];
    expect(order.orderId).toBe(7n);
    expect(order.quantity).toBe(500n);
    expect(order.originalQuantity).toBe(1000n);
    expect(order.side).toBe(Side.YesAsk);
    expect(order.timestamp).toBe(1700000123n);
    expect(order.priceLevel).toBe(25);
    expect(order.owner.equals(new PublicKey(ownerBuf))).toBe(true);
  });

  it("reads orders from multiple price levels", () => {
    const buf = createEmptyBuffer();
    writeOrder(buf, 1, 0, { orderId: 1n, isActive: true });
    writeOrder(buf, 50, 0, { orderId: 2n, isActive: true });
    writeOrder(buf, 99, 0, { orderId: 3n, isActive: true });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(3);
    const prices = result.orders.map((o) => o.priceLevel).sort((a, b) => a - b);
    expect(prices).toEqual([1, 50, 99]);
  });
});

describe("buildYesView", () => {
  function makeOrder(
    priceLevel: number,
    side: number,
    quantity: bigint = 100n,
  ): ActiveOrder {
    return {
      owner: PublicKey.unique(),
      orderId: 1n,
      quantity,
      originalQuantity: quantity,
      side: side as any,
      timestamp: 0n,
      priceLevel,
    };
  }

  it("separates USDC bids and Yes asks correctly", () => {
    const orders: ActiveOrder[] = [
      makeOrder(40, Side.UsdcBid, 200n),
      makeOrder(60, Side.YesAsk, 300n),
      makeOrder(55, Side.NoBackedBid, 100n), // excluded from Yes view
    ];

    const view = buildYesView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(40);
    expect(view.bids[0].totalQuantity).toBe(200n);

    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(60);
    expect(view.asks[0].totalQuantity).toBe(300n);
  });

  it("excludes NoBackedBid orders", () => {
    const orders: ActiveOrder[] = [
      makeOrder(55, Side.NoBackedBid, 100n),
    ];
    const view = buildYesView(orders);
    expect(view.bids).toHaveLength(0);
    expect(view.asks).toHaveLength(0);
  });

  it("returns empty views for empty orders", () => {
    const view = buildYesView([]);
    expect(view.bids).toHaveLength(0);
    expect(view.asks).toHaveLength(0);
    expect(view.bestBid).toBeNull();
    expect(view.bestAsk).toBeNull();
    expect(view.spread).toBeNull();
  });

  it("calculates spread correctly", () => {
    const orders: ActiveOrder[] = [
      makeOrder(45, Side.UsdcBid),
      makeOrder(55, Side.YesAsk),
    ];
    const view = buildYesView(orders);
    expect(view.bestBid).toBe(45);
    expect(view.bestAsk).toBe(55);
    expect(view.spread).toBe(10);
  });

  it("aggregates multiple orders at same price level", () => {
    const orders: ActiveOrder[] = [
      makeOrder(50, Side.UsdcBid, 100n),
      makeOrder(50, Side.UsdcBid, 200n),
    ];
    const view = buildYesView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].totalQuantity).toBe(300n);
    expect(view.bids[0].orderCount).toBe(2);
  });
});

describe("buildNoView", () => {
  function makeOrder(
    priceLevel: number,
    side: number,
    quantity: bigint = 100n,
  ): ActiveOrder {
    return {
      owner: PublicKey.unique(),
      orderId: 1n,
      quantity,
      originalQuantity: quantity,
      side: side as any,
      timestamp: 0n,
      priceLevel,
    };
  }

  it("inverts USDC bid at price 60 to No ask at price 40", () => {
    // USDC bid at price 60 → No bid at price 100-60=40
    // Wait, re-read the code: USDC bids → inverted to No bids
    const orders: ActiveOrder[] = [makeOrder(60, Side.UsdcBid, 200n)];
    const view = buildNoView(orders);
    // USDC bid at 60 → No bid at 40
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(40);
  });

  it("inverts Yes ask at price 70 to No ask at price 30", () => {
    // Yes ask at price 70 → No ask at 100-70=30
    const orders: ActiveOrder[] = [makeOrder(70, Side.YesAsk, 150n)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(30);
    expect(view.asks[0].totalQuantity).toBe(150n);
  });

  it("No-backed bid at price 55 stays at price 55", () => {
    const orders: ActiveOrder[] = [makeOrder(55, Side.NoBackedBid, 100n)];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(55);
  });

  it("edge case: price 1 inverts to 99", () => {
    const orders: ActiveOrder[] = [makeOrder(1, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(99);
  });

  it("edge case: price 99 inverts to 1", () => {
    const orders: ActiveOrder[] = [makeOrder(99, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(1);
  });

  it("edge case: price 50 inverts to 50", () => {
    const orders: ActiveOrder[] = [makeOrder(50, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(50);
  });

  it("returns empty views for empty orders", () => {
    const view = buildNoView([]);
    expect(view.bids).toHaveLength(0);
    expect(view.asks).toHaveLength(0);
    expect(view.bestBid).toBeNull();
    expect(view.bestAsk).toBeNull();
    expect(view.spread).toBeNull();
  });

  it("calculates spread correctly with inverted prices", () => {
    const orders: ActiveOrder[] = [
      makeOrder(60, Side.UsdcBid),   // → No bid at 40
      makeOrder(70, Side.YesAsk),    // → No ask at 30
    ];
    const view = buildNoView(orders);
    // bids at 40, asks at 30 → spread = 30 - 40 = -10
    expect(view.bestBid).toBe(40);
    expect(view.bestAsk).toBe(30);
    expect(view.spread).toBe(-10);
  });

  it("merges No-backed bids with inverted USDC bids at same price", () => {
    const orders: ActiveOrder[] = [
      makeOrder(55, Side.NoBackedBid, 100n), // No bid at 55
      makeOrder(45, Side.UsdcBid, 200n),     // inverted: No bid at 55
    ];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(55);
    expect(view.bids[0].totalQuantity).toBe(300n);
    expect(view.bids[0].orderCount).toBe(2);
  });
});
