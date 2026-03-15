use anchor_lang::prelude::*;

/// Maximum price levels (1-99 cents)
pub const MAX_PRICE_LEVELS: usize = 99;
/// Minimum order size in token lamports (1 token = 1_000_000)
pub const MIN_ORDER_SIZE: u64 = 1_000_000;
/// USDC lamports per dollar
pub const USDC_LAMPORTS_PER_DOLLAR: u64 = 1_000_000;
/// Conversion factor: price (1-99) to USDC lamports. Price 60 → 600_000 ($0.60)
pub const PRICE_TO_USDC_LAMPORTS: u64 = USDC_LAMPORTS_PER_DOLLAR / 100;
/// Maximum fills per crank_cancel call
pub const CRANK_BATCH_SIZE: usize = 32;
/// Maximum settlement overrides
pub const MAX_OVERRIDES: u8 = 3;
/// Override window duration in seconds (1 second; 1s in stress-test builds)
#[cfg(not(feature = "stress-test"))]
pub const OVERRIDE_WINDOW_SECS: i64 = 1;
#[cfg(feature = "stress-test")]
pub const OVERRIDE_WINDOW_SECS: i64 = 1;

/// Admin settle delay in seconds (5 minutes after market close; 5s in stress-test builds)
#[cfg(not(feature = "stress-test"))]
pub const ADMIN_SETTLE_DELAY_SECS: i64 = 300;
#[cfg(feature = "stress-test")]
pub const ADMIN_SETTLE_DELAY_SECS: i64 = 5;

/// Order side types
pub const SIDE_USDC_BID: u8 = 0;   // Buy Yes — escrow USDC
pub const SIDE_YES_ASK: u8 = 1;    // Sell Yes — escrow Yes tokens
pub const SIDE_NO_BID: u8 = 2;     // Sell No — escrow No tokens (No-backed bid)

/// Order type
pub const ORDER_TYPE_MARKET: u8 = 0;
pub const ORDER_TYPE_LIMIT: u8 = 1;

/// Market outcome
pub const OUTCOME_UNSETTLED: u8 = 0;
pub const OUTCOME_YES_WINS: u8 = 1;
pub const OUTCOME_NO_WINS: u8 = 2;

// ---------------------------------------------------------------------------
// Sparse Order Book layout constants — variable-size levels
// ---------------------------------------------------------------------------

/// Unallocated price map entry (u16 sentinel)
pub const PRICE_UNALLOCATED: u16 = 0xFFFF;

/// Order slot size in bytes (80 + 32 for rent_depositor)
pub const ORDER_SLOT_SIZE: usize = 112;
/// Level header size in bytes (price + active_count + slot_count + padding)
pub const LEVEL_HEADER_SIZE: usize = 8;

// Header byte offsets (including 8-byte Anchor discriminator)
//
// New layout: price_map is [u16; 99] = 198 bytes (stores byte offsets, not indices)
//
// [0..8]     discriminator
// [8..40]    market Pubkey
// [40..48]   next_order_id u64
// [48..246]  price_map [u16 LE; 99] — byte offsets, 0xFFFF = unallocated
// [246]      level_count u8
// [247]      max_levels u8 (allocated level count, monotonically increasing)
// [248]      bump u8
// [249..270] reserved
pub const DISC_SIZE: usize = 8;
pub const HDR_MARKET: usize = 8;          // [8..40]   Pubkey
pub const HDR_NEXT_ORDER_ID: usize = 40;  // [40..48]  u64
pub const HDR_PRICE_MAP: usize = 48;      // [48..246] [u16; 99]
pub const HDR_LEVEL_COUNT: usize = 246;   // [246] u8
pub const HDR_MAX_LEVELS: usize = 247;    // [247] u8
pub const HDR_BUMP: usize = 248;          // [248] u8
pub const HEADER_SIZE: usize = 270;       // Total header

// Level header byte offsets (relative to level start)
pub const LVL_PRICE: usize = 0;
pub const LVL_ACTIVE_COUNT: usize = 1;
pub const LVL_SLOT_COUNT: usize = 2;

// Order slot field offsets within a slot
pub const SLOT_OWNER: usize = 0;       // [0..32]  Pubkey
pub const SLOT_ORDER_ID: usize = 32;   // [32..40] u64
pub const SLOT_QUANTITY: usize = 40;   // [40..48] u64
pub const SLOT_ORIG_QTY: usize = 48;   // [48..56] u64
pub const SLOT_SIDE: usize = 56;       // [56] u8
pub const SLOT_PAD1_START: usize = SLOT_SIDE + 1;       // 57
pub const SLOT_PAD1_END: usize = 64;                    // exclusive
pub const SLOT_TIMESTAMP: usize = 64;  // [64..72] i64
pub const SLOT_IS_ACTIVE: usize = 72;  // [72] u8
pub const SLOT_PAD2_START: usize = SLOT_IS_ACTIVE + 1;  // 73
pub const SLOT_PAD2_END: usize = 80;                    // exclusive
pub const SLOT_RENT_DEPOSITOR: usize = 80; // [80..112] Pubkey

// Compile-time assertions
const _: () = assert!(SLOT_PAD1_START == SLOT_SIDE + 1);
const _: () = assert!(SLOT_PAD1_END == SLOT_TIMESTAMP);
const _: () = assert!(SLOT_PAD2_START == SLOT_IS_ACTIVE + 1);
const _: () = assert!(SLOT_PAD2_END == SLOT_RENT_DEPOSITOR);
const _: () = assert!(SLOT_RENT_DEPOSITOR + 32 == ORDER_SLOT_SIZE);
const _: () = assert!(HDR_PRICE_MAP + MAX_PRICE_LEVELS * 2 == HDR_LEVEL_COUNT);

/// OrderBook PDA seed prefix
pub const ORDER_BOOK_SEED: &[u8] = b"order_book";

/// Anchor discriminator for the sparse order book
pub fn sparse_book_discriminator() -> [u8; 8] {
    use anchor_lang::solana_program::hash::hash;
    let h = hash(b"account:OrderBook");
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&h.to_bytes()[..8]);
    disc
}

// ---------------------------------------------------------------------------
// Byte-level accessor functions
// ---------------------------------------------------------------------------

#[inline]
pub fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

#[inline]
pub fn write_pubkey(data: &mut [u8], offset: usize, key: &Pubkey) {
    data[offset..offset + 32].copy_from_slice(key.as_ref());
}

#[inline]
pub fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[inline]
pub fn write_u64(data: &mut [u8], offset: usize, val: u64) {
    data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
}

#[inline]
pub fn read_i64(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[inline]
pub fn write_i64(data: &mut [u8], offset: usize, val: i64) {
    data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
}

#[inline]
pub fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

#[inline]
pub fn write_u16(data: &mut [u8], offset: usize, val: u16) {
    let bytes = val.to_le_bytes();
    data[offset] = bytes[0];
    data[offset + 1] = bytes[1];
}

// ---------------------------------------------------------------------------
// Header accessors
// ---------------------------------------------------------------------------

#[inline]
pub fn book_market(data: &[u8]) -> Pubkey {
    read_pubkey(data, HDR_MARKET)
}

#[inline]
pub fn book_next_order_id(data: &[u8]) -> u64 {
    read_u64(data, HDR_NEXT_ORDER_ID)
}

/// Read the byte offset for a price level from the price map (u16 LE).
/// Returns PRICE_UNALLOCATED (0xFFFF) if no level exists at this price.
#[inline]
pub fn book_price_map(data: &[u8], price: u8) -> u16 {
    let idx = HDR_PRICE_MAP + (price as usize - 1) * 2;
    read_u16(data, idx)
}

/// Write a byte offset into the price map for a given price.
#[inline]
pub fn book_set_price_map(data: &mut [u8], price: u8, offset: u16) {
    let idx = HDR_PRICE_MAP + (price as usize - 1) * 2;
    write_u16(data, idx, offset);
}

#[inline]
pub fn book_level_count(data: &[u8]) -> u8 {
    data[HDR_LEVEL_COUNT]
}

#[inline]
pub fn book_max_levels(data: &[u8]) -> u8 {
    data[HDR_MAX_LEVELS]
}

#[inline]
pub fn book_bump(data: &[u8]) -> u8 {
    data[HDR_BUMP]
}

// ---------------------------------------------------------------------------
// Level accessors — take `loff` (byte offset of level within account data)
// ---------------------------------------------------------------------------

/// Read the price stored at a level.
#[inline]
pub fn level_price(data: &[u8], loff: usize) -> u8 {
    data[loff + LVL_PRICE]
}

/// Read the active order count at a level.
#[inline]
pub fn level_count(data: &[u8], loff: usize) -> u8 {
    data[loff + LVL_ACTIVE_COUNT]
}

/// Set the active order count at a level.
#[inline]
pub fn set_level_count(data: &mut [u8], loff: usize, count: u8) {
    data[loff + LVL_ACTIVE_COUNT] = count;
}

/// Read the total allocated slot count at a level.
#[inline]
pub fn level_slot_count(data: &[u8], loff: usize) -> u8 {
    data[loff + LVL_SLOT_COUNT]
}

/// Set the total allocated slot count at a level.
#[inline]
pub fn set_level_slot_count(data: &mut [u8], loff: usize, count: u8) {
    data[loff + LVL_SLOT_COUNT] = count;
}

// ---------------------------------------------------------------------------
// Slot offset computation
// ---------------------------------------------------------------------------

/// Compute the byte offset of a specific order slot given the level's byte offset.
#[inline]
pub fn slot_offset_at(loff: usize, slot_idx: u8) -> usize {
    loff + LEVEL_HEADER_SIZE + slot_idx as usize * ORDER_SLOT_SIZE
}

// ---------------------------------------------------------------------------
// Order slot accessors — take `loff` (level byte offset) and `slot_idx`
// ---------------------------------------------------------------------------

#[inline]
pub fn slot_is_active(data: &[u8], loff: usize, slot_idx: u8) -> bool {
    data[slot_offset_at(loff, slot_idx) + SLOT_IS_ACTIVE] != 0
}

#[inline]
pub fn slot_side(data: &[u8], loff: usize, slot_idx: u8) -> u8 {
    data[slot_offset_at(loff, slot_idx) + SLOT_SIDE]
}

#[inline]
pub fn slot_timestamp(data: &[u8], loff: usize, slot_idx: u8) -> i64 {
    read_i64(data, slot_offset_at(loff, slot_idx) + SLOT_TIMESTAMP)
}

#[inline]
pub fn slot_quantity(data: &[u8], loff: usize, slot_idx: u8) -> u64 {
    read_u64(data, slot_offset_at(loff, slot_idx) + SLOT_QUANTITY)
}

#[inline]
pub fn slot_owner(data: &[u8], loff: usize, slot_idx: u8) -> Pubkey {
    read_pubkey(data, slot_offset_at(loff, slot_idx) + SLOT_OWNER)
}

#[inline]
pub fn slot_order_id(data: &[u8], loff: usize, slot_idx: u8) -> u64 {
    read_u64(data, slot_offset_at(loff, slot_idx) + SLOT_ORDER_ID)
}

#[inline]
pub fn slot_rent_depositor(data: &[u8], loff: usize, slot_idx: u8) -> Pubkey {
    read_pubkey(data, slot_offset_at(loff, slot_idx) + SLOT_RENT_DEPOSITOR)
}

/// Write a complete order slot.
pub fn write_order_slot(
    data: &mut [u8],
    loff: usize,
    slot_idx: u8,
    owner: &Pubkey,
    order_id: u64,
    quantity: u64,
    original_quantity: u64,
    side: u8,
    timestamp: i64,
    rent_depositor: &Pubkey,
) {
    let base = slot_offset_at(loff, slot_idx);
    write_pubkey(data, base + SLOT_OWNER, owner);
    write_u64(data, base + SLOT_ORDER_ID, order_id);
    write_u64(data, base + SLOT_QUANTITY, quantity);
    write_u64(data, base + SLOT_ORIG_QTY, original_quantity);
    data[base + SLOT_SIDE] = side;
    data[base + SLOT_PAD1_START..base + SLOT_PAD1_END].fill(0);
    write_i64(data, base + SLOT_TIMESTAMP, timestamp);
    data[base + SLOT_IS_ACTIVE] = 1;
    data[base + SLOT_PAD2_START..base + SLOT_PAD2_END].fill(0);
    write_pubkey(data, base + SLOT_RENT_DEPOSITOR, rent_depositor);
}

/// Deactivate an order slot (zero quantity + is_active).
pub fn deactivate_slot(data: &mut [u8], loff: usize, slot_idx: u8) {
    let base = slot_offset_at(loff, slot_idx);
    write_u64(data, base + SLOT_QUANTITY, 0);
    data[base + SLOT_IS_ACTIVE] = 0;
}

/// Set the quantity of an order slot.
#[inline]
pub fn set_slot_quantity(data: &mut [u8], loff: usize, slot_idx: u8, qty: u64) {
    write_u64(data, slot_offset_at(loff, slot_idx) + SLOT_QUANTITY, qty);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/// Initialize a sparse order book header in the given data buffer.
/// Buffer must be at least HEADER_SIZE bytes.
pub fn init_sparse_book(data: &mut [u8], market: &Pubkey, bump: u8) {
    // Write discriminator
    data[..DISC_SIZE].copy_from_slice(&sparse_book_discriminator());
    // Market
    write_pubkey(data, HDR_MARKET, market);
    // next_order_id = 0
    write_u64(data, HDR_NEXT_ORDER_ID, 0);
    // price_map: all unallocated (u16 0xFFFF each)
    for p in 0..MAX_PRICE_LEVELS {
        let idx = HDR_PRICE_MAP + p * 2;
        write_u16(data, idx, PRICE_UNALLOCATED);
    }
    // level_count = 0
    data[HDR_LEVEL_COUNT] = 0;
    // max_levels = 0
    data[HDR_MAX_LEVELS] = 0;
    // bump
    data[HDR_BUMP] = bump;
    // reserved = 0
    data[HDR_BUMP + 1..HEADER_SIZE].fill(0);
}

// ---------------------------------------------------------------------------
// Level allocation helpers
// ---------------------------------------------------------------------------

/// Initialize a level at byte offset `loff` for the given price, with 1 slot.
/// The caller must have already reallocated the account data.
pub fn init_level(data: &mut [u8], loff: usize, price: u8) {
    let level_size = LEVEL_HEADER_SIZE + ORDER_SLOT_SIZE; // 1 slot
    // Zero the entire level region
    data[loff..loff + level_size].fill(0);
    // Set price
    data[loff + LVL_PRICE] = price;
    // active_count = 0 (already zeroed)
    // slot_count = 1
    data[loff + LVL_SLOT_COUNT] = 1;

    // Update price_map
    book_set_price_map(data, price, loff as u16);
    // Increment level_count
    data[HDR_LEVEL_COUNT] = data[HDR_LEVEL_COUNT].saturating_add(1);
}

/// Free a level: reset its price_map entry and decrement level_count.
/// Does NOT compact — the space remains allocated but unused.
/// Returns the price that was freed.
pub fn free_level(data: &mut [u8], loff: usize) -> u8 {
    let price = level_price(data, loff);
    // Clear price_map entry
    book_set_price_map(data, price, PRICE_UNALLOCATED);
    // Decrement level_count
    data[HDR_LEVEL_COUNT] = data[HDR_LEVEL_COUNT].saturating_sub(1);
    // Zero the level header (price + active_count + slot_count)
    data[loff + LVL_PRICE] = 0;
    data[loff + LVL_ACTIVE_COUNT] = 0;
    data[loff + LVL_SLOT_COUNT] = 0;
    price
}

/// Verify the sparse order book discriminator.
pub fn verify_discriminator(data: &[u8]) -> bool {
    if data.len() < DISC_SIZE {
        return false;
    }
    data[..DISC_SIZE] == sparse_book_discriminator()
}

// Re-export StrikeMarket constants for backward compat
pub use super::StrikeMarket;
