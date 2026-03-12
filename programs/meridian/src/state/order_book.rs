use anchor_lang::prelude::*;

/// Maximum price levels (1-99 cents)
pub const MAX_PRICE_LEVELS: usize = 99;
/// Maximum orders per price level
pub const MAX_ORDERS_PER_LEVEL: usize = 32;
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

/// A single order slot in the order book
#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct OrderSlot {
    /// Order placer
    pub owner: Pubkey,
    /// Unique ID from next_order_id
    pub order_id: u64,
    /// Remaining quantity (token lamports)
    pub quantity: u64,
    /// Original quantity (for fill tracking)
    pub original_quantity: u64,
    /// 0=USDC bid (Buy Yes), 1=Yes ask (Sell Yes), 2=No-backed bid (Sell No)
    pub side: u8,
    /// Padding for alignment before i64 timestamp
    pub _side_padding: [u8; 7],
    /// Clock::get() at placement
    pub timestamp: i64,
    /// 0 = slot is empty/cancelled, 1 = active
    pub is_active: u8,
    /// Trailing alignment padding
    pub _padding: [u8; 7],
}
// Size: 32 + 8 + 8 + 8 + 1 + 7 + 8 + 1 + 7 = 80 bytes

impl OrderSlot {
    pub fn active(&self) -> bool {
        self.is_active != 0
    }

    pub fn set_active(&mut self, active: bool) {
        self.is_active = if active { 1 } else { 0 };
    }
}

/// A price level containing up to MAX_ORDERS_PER_LEVEL orders
#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct PriceLevel {
    /// Order slots at this price
    pub orders: [OrderSlot; MAX_ORDERS_PER_LEVEL],
    /// Number of active orders at this level
    pub count: u8,
    /// Trailing alignment padding
    pub _padding: [u8; 7],
}
// Size: 32 × 80 + 1 + 7 = 2,568 bytes

/// The full order book — one per market. ZeroCopy for efficient on-chain access.
///
/// bytemuck requires manual Pod/Zeroable impls for arrays > 64 elements.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct OrderBook {
    /// Parent market
    pub market: Pubkey,
    /// Monotonically incrementing order ID counter
    pub next_order_id: u64,
    /// 99 price levels (index 0 = price 1, index 98 = price 99)
    pub levels: [PriceLevel; MAX_PRICE_LEVELS],
    /// PDA bump
    pub bump: u8,
    /// Trailing alignment padding
    pub _padding: [u8; 7],
}
// Size: 32 + 8 + 99 × 2,568 + 1 + 7 = 254,280 bytes

impl OrderBook {
    pub const SEED_PREFIX: &'static [u8] = b"order_book";

    // OrderSlot: 80 bytes. PriceLevel: 32 × 80 + 1 + 7 = 2,568 bytes.
    // OrderBook: 32 + 8 + 99 × 2,568 + 1 + 7 = 254,280 bytes.
    pub const ORDER_SLOT_SIZE: usize = 80;
    pub const PRICE_LEVEL_SIZE: usize = MAX_ORDERS_PER_LEVEL * Self::ORDER_SLOT_SIZE + 1 + 7;
    pub const LEN: usize = 32 + 8 + (MAX_PRICE_LEVELS * Self::PRICE_LEVEL_SIZE) + 1 + 7;
}

// Compile-time size verification for ZeroCopy (repr(C)) types
const _: () = assert!(std::mem::size_of::<OrderSlot>() == 80);
const _: () = assert!(std::mem::size_of::<PriceLevel>() == 2_568);
const _: () = assert!(std::mem::size_of::<OrderBook>() == 254_280);
const _: () = assert!(OrderBook::ORDER_SLOT_SIZE == std::mem::size_of::<OrderSlot>());
const _: () = assert!(OrderBook::PRICE_LEVEL_SIZE == std::mem::size_of::<PriceLevel>());
const _: () = assert!(OrderBook::LEN == std::mem::size_of::<OrderBook>());
