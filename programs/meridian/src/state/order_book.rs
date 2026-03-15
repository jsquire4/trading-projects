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
/// Override window duration in seconds (1 hour; 5s in stress-test builds)
#[cfg(not(feature = "stress-test"))]
pub const OVERRIDE_WINDOW_SECS: i64 = 3600;
#[cfg(feature = "stress-test")]
pub const OVERRIDE_WINDOW_SECS: i64 = 5;

/// Admin settle delay in seconds (1 hour after market close; 5s in stress-test builds)
#[cfg(not(feature = "stress-test"))]
pub const ADMIN_SETTLE_DELAY_SECS: i64 = 3600;
#[cfg(feature = "stress-test")]
pub const ADMIN_SETTLE_DELAY_SECS: i64 = 5;

/// Grace period for partial market close (90 days in seconds; 5s in stress-test builds)
#[cfg(not(feature = "stress-test"))]
pub const CLOSE_GRACE_PERIOD_SECS: i64 = 7_776_000;
#[cfg(feature = "stress-test")]
pub const CLOSE_GRACE_PERIOD_SECS: i64 = 5;

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
// Sparse Order Book layout constants
// ---------------------------------------------------------------------------

/// Initial orders per level when a new level is allocated
pub const INITIAL_ORDERS_PER_LEVEL: u8 = 4;
/// Maximum orders per level (growth cap)
pub const MAX_ORDERS_PER_LEVEL_CAP: u8 = 32;
/// Unallocated price map entry
pub const PRICE_UNALLOCATED: u8 = 0xFF;

/// Order slot size in bytes (80 + 32 for rent_depositor)
pub const ORDER_SLOT_SIZE: usize = 112;
/// Level header size in bytes (price + count + padding)
pub const LEVEL_HEADER_SIZE: usize = 8;

// Header byte offsets (including 8-byte Anchor discriminator)
pub const DISC_SIZE: usize = 8;
pub const HDR_MARKET: usize = 8;       // [8..40]  Pubkey
pub const HDR_NEXT_ORDER_ID: usize = 40; // [40..48] u64
pub const HDR_PRICE_MAP: usize = 48;   // [48..147] [u8; 99]
pub const HDR_LEVEL_COUNT: usize = 147; // [147] u8
pub const HDR_MAX_LEVELS: usize = 148;  // [148] u8
pub const HDR_ORDERS_PER_LEVEL: usize = 149; // [149] u8
pub const HDR_BUMP: usize = 150;       // [150] u8
pub const HEADER_SIZE: usize = 168;    // Total header including discriminator

// Order slot field offsets within a slot
pub const SLOT_OWNER: usize = 0;       // [0..32]  Pubkey
pub const SLOT_ORDER_ID: usize = 32;   // [32..40] u64
pub const SLOT_QUANTITY: usize = 40;   // [40..48] u64
pub const SLOT_ORIG_QTY: usize = 48;   // [48..56] u64
pub const SLOT_SIDE: usize = 56;       // [56] u8
pub const SLOT_TIMESTAMP: usize = 64;  // [64..72] i64
pub const SLOT_IS_ACTIVE: usize = 72;  // [72] u8
pub const SLOT_RENT_DEPOSITOR: usize = 80; // [80..112] Pubkey

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
// Byte-level accessor functions for sparse order book
// ---------------------------------------------------------------------------

/// Compute the byte offset of level `idx` within account data.
#[inline]
pub fn level_offset(data: &[u8], idx: u8) -> usize {
    let opl = data[HDR_ORDERS_PER_LEVEL] as usize;
    let entry_size = LEVEL_HEADER_SIZE + opl * ORDER_SLOT_SIZE;
    HEADER_SIZE + idx as usize * entry_size
}

/// Compute the byte offset of a specific order slot.
#[inline]
pub fn slot_offset(data: &[u8], level_idx: u8, slot_idx: u8) -> usize {
    level_offset(data, level_idx) + LEVEL_HEADER_SIZE + slot_idx as usize * ORDER_SLOT_SIZE
}

/// Compute the total account size for given level count and orders_per_level.
#[inline]
pub fn account_size(level_count: u8, orders_per_level: u8) -> usize {
    let entry_size = LEVEL_HEADER_SIZE + orders_per_level as usize * ORDER_SLOT_SIZE;
    HEADER_SIZE + level_count as usize * entry_size
}

/// Read a Pubkey from data at the given offset.
#[inline]
pub fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

/// Write a Pubkey to data at the given offset.
#[inline]
pub fn write_pubkey(data: &mut [u8], offset: usize, key: &Pubkey) {
    data[offset..offset + 32].copy_from_slice(key.as_ref());
}

/// Read a little-endian u64 from data.
#[inline]
pub fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Write a little-endian u64 to data.
#[inline]
pub fn write_u64(data: &mut [u8], offset: usize, val: u64) {
    data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
}

/// Read a little-endian i64 from data.
#[inline]
pub fn read_i64(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Write a little-endian i64 to data.
#[inline]
pub fn write_i64(data: &mut [u8], offset: usize, val: i64) {
    data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
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

#[inline]
pub fn book_price_map(data: &[u8], price: u8) -> u8 {
    data[HDR_PRICE_MAP + (price as usize - 1)]
}

#[inline]
pub fn book_set_price_map(data: &mut [u8], price: u8, level_idx: u8) {
    data[HDR_PRICE_MAP + (price as usize - 1)] = level_idx;
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
pub fn book_orders_per_level(data: &[u8]) -> u8 {
    data[HDR_ORDERS_PER_LEVEL]
}

#[inline]
pub fn book_bump(data: &[u8]) -> u8 {
    data[HDR_BUMP]
}

// ---------------------------------------------------------------------------
// Level accessors
// ---------------------------------------------------------------------------

/// Read the price stored at level `idx`.
#[inline]
pub fn level_price(data: &[u8], idx: u8) -> u8 {
    data[level_offset(data, idx)]
}

/// Read the active order count at level `idx`.
#[inline]
pub fn level_count(data: &[u8], idx: u8) -> u8 {
    data[level_offset(data, idx) + 1]
}

/// Set the active order count at level `idx`.
#[inline]
pub fn set_level_count(data: &mut [u8], idx: u8, count: u8) {
    let off = level_offset(data, idx) + 1;
    data[off] = count;
}

// ---------------------------------------------------------------------------
// Order slot accessors
// ---------------------------------------------------------------------------

#[inline]
pub fn slot_is_active(data: &[u8], level_idx: u8, slot_idx: u8) -> bool {
    data[slot_offset(data, level_idx, slot_idx) + SLOT_IS_ACTIVE] != 0
}

#[inline]
pub fn slot_side(data: &[u8], level_idx: u8, slot_idx: u8) -> u8 {
    data[slot_offset(data, level_idx, slot_idx) + SLOT_SIDE]
}

#[inline]
pub fn slot_timestamp(data: &[u8], level_idx: u8, slot_idx: u8) -> i64 {
    read_i64(data, slot_offset(data, level_idx, slot_idx) + SLOT_TIMESTAMP)
}

#[inline]
pub fn slot_quantity(data: &[u8], level_idx: u8, slot_idx: u8) -> u64 {
    read_u64(data, slot_offset(data, level_idx, slot_idx) + SLOT_QUANTITY)
}

#[inline]
pub fn slot_owner(data: &[u8], level_idx: u8, slot_idx: u8) -> Pubkey {
    read_pubkey(data, slot_offset(data, level_idx, slot_idx) + SLOT_OWNER)
}

#[inline]
pub fn slot_order_id(data: &[u8], level_idx: u8, slot_idx: u8) -> u64 {
    read_u64(data, slot_offset(data, level_idx, slot_idx) + SLOT_ORDER_ID)
}

#[inline]
pub fn slot_rent_depositor(data: &[u8], level_idx: u8, slot_idx: u8) -> Pubkey {
    read_pubkey(data, slot_offset(data, level_idx, slot_idx) + SLOT_RENT_DEPOSITOR)
}

/// Write a complete order slot.
pub fn write_order_slot(
    data: &mut [u8],
    level_idx: u8,
    slot_idx: u8,
    owner: &Pubkey,
    order_id: u64,
    quantity: u64,
    original_quantity: u64,
    side: u8,
    timestamp: i64,
    rent_depositor: &Pubkey,
) {
    let base = slot_offset(data, level_idx, slot_idx);
    write_pubkey(data, base + SLOT_OWNER, owner);
    write_u64(data, base + SLOT_ORDER_ID, order_id);
    write_u64(data, base + SLOT_QUANTITY, quantity);
    write_u64(data, base + SLOT_ORIG_QTY, original_quantity);
    data[base + SLOT_SIDE] = side;
    // Zero padding bytes [57..64]
    data[base + 57..base + 64].fill(0);
    write_i64(data, base + SLOT_TIMESTAMP, timestamp);
    data[base + SLOT_IS_ACTIVE] = 1;
    // Zero padding bytes [73..80]
    data[base + 73..base + 80].fill(0);
    write_pubkey(data, base + SLOT_RENT_DEPOSITOR, rent_depositor);
}

/// Deactivate an order slot (zero quantity + is_active).
pub fn deactivate_slot(data: &mut [u8], level_idx: u8, slot_idx: u8) {
    let base = slot_offset(data, level_idx, slot_idx);
    write_u64(data, base + SLOT_QUANTITY, 0);
    data[base + SLOT_IS_ACTIVE] = 0;
}

/// Set the quantity of an order slot.
#[inline]
pub fn set_slot_quantity(data: &mut [u8], level_idx: u8, slot_idx: u8, qty: u64) {
    write_u64(data, slot_offset(data, level_idx, slot_idx) + SLOT_QUANTITY, qty);
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
    // price_map: all unallocated
    data[HDR_PRICE_MAP..HDR_PRICE_MAP + MAX_PRICE_LEVELS].fill(PRICE_UNALLOCATED);
    // level_count = 0
    data[HDR_LEVEL_COUNT] = 0;
    // max_levels = 0
    data[HDR_MAX_LEVELS] = 0;
    // orders_per_level = INITIAL_ORDERS_PER_LEVEL
    data[HDR_ORDERS_PER_LEVEL] = INITIAL_ORDERS_PER_LEVEL;
    // bump
    data[HDR_BUMP] = bump;
    // reserved = 0
    data[HDR_BUMP + 1..HEADER_SIZE].fill(0);
}

// ---------------------------------------------------------------------------
// Level allocation helpers
// ---------------------------------------------------------------------------

/// Initialize a newly allocated level at `level_idx` for the given price.
pub fn init_level(data: &mut [u8], level_idx: u8, price: u8) {
    let base = level_offset(data, level_idx);
    let opl = data[HDR_ORDERS_PER_LEVEL] as usize;
    let entry_size = LEVEL_HEADER_SIZE + opl * ORDER_SLOT_SIZE;

    // Zero the entire level
    data[base..base + entry_size].fill(0);
    // Set price
    data[base] = price;
    // count = 0 (already zeroed)

    // Update price_map
    book_set_price_map(data, price, level_idx);
    // Increment level_count
    data[HDR_LEVEL_COUNT] += 1;
}

/// Free a level: reset its price_map entry and decrement level_count.
/// Does NOT compact levels — the slot remains allocated but unused.
/// Returns the price that was freed.
pub fn free_level(data: &mut [u8], level_idx: u8) -> u8 {
    let price = level_price(data, level_idx);
    // Clear price_map entry
    book_set_price_map(data, price, PRICE_UNALLOCATED);
    // Decrement level_count
    data[HDR_LEVEL_COUNT] = data[HDR_LEVEL_COUNT].saturating_sub(1);
    // Zero the level header (price + count)
    let base = level_offset(data, level_idx);
    data[base] = 0;
    data[base + 1] = 0;
    price
}

/// Find a free level slot (allocated space but not in use).
/// Returns None if max_levels are all in use.
pub fn find_free_level_slot(data: &[u8]) -> Option<u8> {
    let max = data[HDR_MAX_LEVELS];
    for i in 0..max {
        // A level slot is free if its price is 0 (unused)
        if level_price(data, i) == 0 {
            return Some(i);
        }
    }
    None
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
