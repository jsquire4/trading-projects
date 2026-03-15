import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import {
  deserializeOrderBook,
  buildYesView,
  buildNoView,
  Side,
  type ActiveOrder,
} from "../orderbook";

// ---------------------------------------------------------------------------
// Sparse layout constants (must match orderbook.ts / on-chain order_book.rs)
// ---------------------------------------------------------------------------

const DISC_SIZE = 8;
const HDR_MARKET = 8;
const HDR_NEXT_ORDER_ID = 40;
const HDR_PRICE_MAP = 48;
const HDR_LEVEL_COUNT = 147;
const HDR_MAX_LEVELS = 148;
const HDR_ORDERS_PER_LEVEL = 149;
const HDR_BUMP = 150;
const HEADER_SIZE = 168;
const LEVEL_HEADER_SIZE = 8;
const ORDER_SLOT_SIZE = 112;
const MAX_PRICE_LEVELS = 99;
const PRICE_UNALLOCATED = 0xFF;
const ORDERS_PER_LEVEL = 4; // matches INITIAL_ORDERS_PER_LEVEL

// Slot offsets
const SLOT_OWNER = 0;
const SLOT_ORDER_ID = 32;
const SLOT_QUANTITY = 40;
const SLOT_ORIG_QTY = 48;
const SLOT_SIDE = 56;
const SLOT_TIMESTAMP = 64;
const SLOT_IS_ACTIVE = 72;
const SLOT_RENT_DEPOSITOR = 80;

function sparseDiscriminator(): Buffer {
  const hash = createHash("sha256").update("account:OrderBook").digest();
  return hash.subarray(0, 8);
}

// ---------------------------------------------------------------------------
// Helpers to build mock sparse buffers
// ---------------------------------------------------------------------------

function levelEntrySize(): number {
  return LEVEL_HEADER_SIZE + ORDERS_PER_LEVEL * ORDER_SLOT_SIZE;
}

/** Create a sparse book buffer with the given number of allocated levels. */
function createSparseBuffer(numLevels: number = 0): Buffer {
  const size = HEADER_SIZE + numLevels * levelEntrySize();
  const buf = Buffer.alloc(size, 0);
  // Discriminator
  sparseDiscriminator().copy(buf, 0);
  // price_map: all unallocated
  buf.fill(PRICE_UNALLOCATED, HDR_PRICE_MAP, HDR_PRICE_MAP + MAX_PRICE_LEVELS);
  // orders_per_level
  buf[HDR_ORDERS_PER_LEVEL] = ORDERS_PER_LEVEL;
  buf[HDR_MAX_LEVELS] = numLevels;
  buf[HDR_LEVEL_COUNT] = 0;
  return buf;
}

/** Allocate a level in the buffer for a given price. Returns the level index. */
function allocateLevel(buf: Buffer, price: number): number {
  const levelIdx = buf[HDR_LEVEL_COUNT];
  // Set price_map
  buf[HDR_PRICE_MAP + (price - 1)] = levelIdx;
  // Set level header: price byte
  const levelBase = HEADER_SIZE + levelIdx * levelEntrySize();
  buf[levelBase] = price;
  // Increment level_count
  buf[HDR_LEVEL_COUNT] = levelIdx + 1;
  return levelIdx;
}

/** Write an order slot into a sparse buffer. */
function writeOrder(
  buf: Buffer,
  levelIdx: number,
  slotIdx: number,
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
  const slotBase = HEADER_SIZE + levelIdx * levelEntrySize() + LEVEL_HEADER_SIZE + slotIdx * ORDER_SLOT_SIZE;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const owner = opts.owner ?? Buffer.alloc(32, 1);
  owner.copy(buf, slotBase + SLOT_OWNER, 0, 32);

  dv.setBigUint64(slotBase + SLOT_ORDER_ID, opts.orderId ?? 1n, true);
  dv.setBigUint64(slotBase + SLOT_QUANTITY, opts.quantity ?? 100n, true);
  dv.setBigUint64(slotBase + SLOT_ORIG_QTY, opts.originalQuantity ?? 100n, true);
  buf[slotBase + SLOT_SIDE] = opts.side ?? Side.UsdcBid;
  dv.setBigInt64(slotBase + SLOT_TIMESTAMP, opts.timestamp ?? 1700000000n, true);
  buf[slotBase + SLOT_IS_ACTIVE] = opts.isActive !== false ? 1 : 0;
  // rent_depositor (32 bytes) — defaults to zero
}

function setMarketPubkey(buf: Buffer, pubkey: PublicKey) {
  pubkey.toBuffer().copy(buf, HDR_MARKET);
}

function setNextOrderId(buf: Buffer, id: bigint) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(HDR_NEXT_ORDER_ID, id, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deserializeOrderBook (sparse)", () => {
  it("returns empty orders for a header-only book (no levels)", () => {
    const buf = createSparseBuffer(0);
    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(0);
  });

  it("returns only active orders, skips inactive", () => {
    const buf = createSparseBuffer(1);
    const lvl = allocateLevel(buf, 50);

    writeOrder(buf, lvl, 0, { orderId: 1n, isActive: true });
    writeOrder(buf, lvl, 1, { orderId: 2n, isActive: false });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].orderId).toBe(1n);
    expect(result.orders[0].priceLevel).toBe(50);
  });

  it("reads market pubkey and nextOrderId correctly", () => {
    const buf = createSparseBuffer(0);
    const marketKey = PublicKey.unique();
    setMarketPubkey(buf, marketKey);
    setNextOrderId(buf, 42n);

    const result = deserializeOrderBook(buf);
    expect(result.market.equals(marketKey)).toBe(true);
    expect(result.nextOrderId).toBe(42n);
  });

  it("reads all order fields correctly", () => {
    const buf = createSparseBuffer(1);
    const lvl = allocateLevel(buf, 25);
    const ownerBuf = PublicKey.unique().toBuffer();
    writeOrder(buf, lvl, 0, {
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
    const buf = createSparseBuffer(3);
    const lvl1 = allocateLevel(buf, 1);
    const lvl50 = allocateLevel(buf, 50);
    const lvl99 = allocateLevel(buf, 99);

    writeOrder(buf, lvl1, 0, { orderId: 1n, isActive: true });
    writeOrder(buf, lvl50, 0, { orderId: 2n, isActive: true });
    writeOrder(buf, lvl99, 0, { orderId: 3n, isActive: true });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(3);
    const prices = result.orders.map((o) => o.priceLevel).sort((a, b) => a - b);
    expect(prices).toEqual([1, 50, 99]);
  });

  it("skips unallocated prices in price_map", () => {
    const buf = createSparseBuffer(1);
    // Only allocate price 42 — all other prices should be skipped
    const lvl = allocateLevel(buf, 42);
    writeOrder(buf, lvl, 0, { orderId: 1n, isActive: true });

    const result = deserializeOrderBook(buf);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].priceLevel).toBe(42);
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
    const orders: ActiveOrder[] = [makeOrder(60, Side.UsdcBid, 200n)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(40);
    expect(view.asks[0].totalQuantity).toBe(200n);
  });

  it("inverts Yes ask at price 70 to No bid at price 30", () => {
    const orders: ActiveOrder[] = [makeOrder(70, Side.YesAsk, 150n)];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(30);
    expect(view.bids[0].totalQuantity).toBe(150n);
  });

  it("No-backed bid at price 55 becomes No ask at price 55", () => {
    const orders: ActiveOrder[] = [makeOrder(55, Side.NoBackedBid, 100n)];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(55);
  });

  it("edge case: YesAsk price 1 → No bid at 99", () => {
    const orders: ActiveOrder[] = [makeOrder(1, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(99);
  });

  it("edge case: YesAsk price 99 → No bid at 1", () => {
    const orders: ActiveOrder[] = [makeOrder(99, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(1);
  });

  it("edge case: YesAsk price 50 → No bid at 50", () => {
    const orders: ActiveOrder[] = [makeOrder(50, Side.YesAsk)];
    const view = buildNoView(orders);
    expect(view.bids).toHaveLength(1);
    expect(view.bids[0].price).toBe(50);
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
      makeOrder(60, Side.UsdcBid),
      makeOrder(70, Side.YesAsk),
    ];
    const view = buildNoView(orders);
    expect(view.bestBid).toBe(30);
    expect(view.bestAsk).toBe(40);
    expect(view.spread).toBe(10);
  });

  it("merges No-backed bids with inverted USDC bids at same ask price", () => {
    const orders: ActiveOrder[] = [
      makeOrder(55, Side.NoBackedBid, 100n),
      makeOrder(45, Side.UsdcBid, 200n),
    ];
    const view = buildNoView(orders);
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0].price).toBe(55);
    expect(view.asks[0].totalQuantity).toBe(300n);
    expect(view.asks[0].orderCount).toBe(2);
  });
});
