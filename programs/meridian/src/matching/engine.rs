/// Matching engine — pure functions for price-time priority order matching.
///
/// Handles two settlement paths:
/// - Standard swap: USDC bid (side=0) matched with Yes ask (side=1)
/// - Merge/burn: No-backed bid (side=2) matched with Yes ask (side=1)
///
/// The engine never touches accounts directly — it operates on OrderBook
/// data and returns fill results for the instruction handler to execute.

use anchor_lang::prelude::*;
use crate::state::order_book::*;

/// The total price in cents for a Yes+No pair (always $1.00 = 100 cents).
/// Used in merge/burn matching to compute the price complement:
/// if a No-backed bid is at price P, the maximum Yes ask it can match is (MERGE_TOTAL_CENTS - P).
const MERGE_TOTAL_CENTS: u8 = 100;

/// Result of a single fill during matching
#[derive(Clone, Debug)]
pub struct Fill {
    /// Maker (resting order) owner
    pub maker: Pubkey,
    /// Maker's order ID
    pub maker_order_id: u64,
    /// Maker's side (0=USDC bid, 1=Yes ask, 2=No-backed bid)
    pub maker_side: u8,
    /// Taker's side
    pub taker_side: u8,
    /// Fill price (resting order's price, 1-99)
    pub price: u8,
    /// Fill quantity in token lamports
    pub quantity: u64,
    /// True if this is a merge/burn fill (No-backed bid × Yes ask)
    pub is_merge: bool,
    /// Price level index (0-based, = price - 1)
    pub price_level_idx: usize,
    /// Slot index within the price level
    pub slot_idx: usize,
}

/// Result of running the matching engine
#[derive(Clone, Debug)]
pub struct MatchResult {
    /// Fills that occurred
    pub fills: Vec<Fill>,
    /// Remaining quantity that wasn't filled (rests as limit or rejected for market)
    pub remaining_quantity: u64,
    /// True if the resting order placement failed (e.g. level full)
    pub resting_failed: bool,
}

/// Place a new order into the book, attempting to match against resting orders.
///
/// Returns the match result. The caller (instruction handler) is responsible for
/// executing the actual token transfers, burns, and escrow operations.
///
/// # Arguments
/// * `book` - Mutable reference to the ZeroCopy OrderBook
/// * `taker` - Taker's pubkey
/// * `side` - 0=USDC bid (Buy Yes), 1=Yes ask (Sell Yes), 2=No-backed bid (Sell No)
/// * `price` - Price in cents (1-99). Market buy=99, market sell=1.
/// * `quantity` - Order size in token lamports
/// * `order_type` - 0=Market, 1=Limit
/// * `max_fills` - Maximum number of fills to execute
/// * `timestamp` - Current clock timestamp
pub fn match_order(
    book: &mut OrderBook,
    taker: Pubkey,
    side: u8,
    price: u8,
    quantity: u64,
    order_type: u8,
    max_fills: u8,
    timestamp: i64,
) -> MatchResult {
    let mut result = MatchResult {
        fills: Vec::new(),
        remaining_quantity: quantity,
        resting_failed: false,
    };

    // Match against the opposite side of the book
    match side {
        // USDC bid (Buy Yes) — matches against Yes asks (side=1)
        // Walk asks from lowest price upward
        SIDE_USDC_BID => {
            match_against_asks(book, side, price, &mut result, max_fills);
        }
        // Yes ask (Sell Yes) — matches against USDC bids (side=0) AND No-backed bids (side=2)
        // Walk bids from highest price downward
        SIDE_YES_ASK => {
            match_against_bids(book, side, price, &mut result, max_fills);
        }
        // No-backed bid (Sell No) — matches against Yes asks (side=1)
        // Walk asks from lowest price upward (merge/burn)
        SIDE_NO_BID => {
            match_against_asks_merge(book, side, price, &mut result, max_fills);
        }
        _ => {} // Invalid side — caller validates before calling
    }

    // If limit order and there's remaining quantity, place it on the book
    if order_type == ORDER_TYPE_LIMIT && result.remaining_quantity >= MIN_ORDER_SIZE {
        match place_resting_order(
            book,
            taker,
            side,
            price,
            result.remaining_quantity,
            quantity,
            timestamp,
        ) {
            Ok(_order_id) => {}
            Err(()) => {
                result.resting_failed = true;
            }
        }
    }

    result
}

/// Match a USDC bid against Yes asks (standard swap).
/// Walks price levels from lowest ask upward until price exceeds bid or max_fills hit.
fn match_against_asks(
    book: &mut OrderBook,
    taker_side: u8,
    max_price: u8,
    result: &mut MatchResult,
    max_fills: u8,
) {
    // Walk from price level 0 (price=1) upward
    for level_idx in 0..MAX_PRICE_LEVELS {
        if result.remaining_quantity < MIN_ORDER_SIZE {
            break;
        }
        if result.fills.len() >= max_fills as usize {
            break;
        }

        let ask_price = (level_idx + 1) as u8;
        // Bid must be >= ask price for a fill
        if ask_price > max_price {
            break;
        }

        match_at_level_for_side(
            book, taker_side, SIDE_YES_ASK, ask_price, level_idx, result, max_fills, false,
        );
    }
}

/// Match a No-backed bid against Yes asks (merge/burn).
///
/// Matching condition: Yes ask price Q + No bid price P <= 100.
/// No seller gets $(P/100), Yes seller gets $((100-P)/100).
/// Fill price is the resting order's price.
fn match_against_asks_merge(
    book: &mut OrderBook,
    taker_side: u8,
    no_bid_price: u8,
    result: &mut MatchResult,
    max_fills: u8,
) {
    // Max Yes ask price that this No bid can match against
    let max_yes_ask = MERGE_TOTAL_CENTS.saturating_sub(no_bid_price);

    // Walk from price level 0 (price=1) upward
    for level_idx in 0..MAX_PRICE_LEVELS {
        if result.remaining_quantity < MIN_ORDER_SIZE {
            break;
        }
        if result.fills.len() >= max_fills as usize {
            break;
        }

        let ask_price = (level_idx + 1) as u8;
        if ask_price > max_yes_ask {
            break;
        }

        match_at_level_for_side(
            book, taker_side, SIDE_YES_ASK, ask_price, level_idx, result, max_fills, true,
        );
    }
}

/// Match a Yes ask against both USDC bids and No-backed bids.
///
/// For USDC bids: fill when bid_price >= ask_price (standard swap).
/// For No-backed bids: fill when (100 - no_bid_price) >= ask_price (merge/burn).
/// Walks from highest bid price downward (price-time priority).
fn match_against_bids(
    book: &mut OrderBook,
    taker_side: u8,
    min_price: u8,
    result: &mut MatchResult,
    max_fills: u8,
) {
    // Walk from price level 98 (price=99) downward
    for level_idx in (0..MAX_PRICE_LEVELS).rev() {
        if result.remaining_quantity < MIN_ORDER_SIZE {
            break;
        }
        if result.fills.len() >= max_fills as usize {
            break;
        }

        let bid_price = (level_idx + 1) as u8;
        // Ask must be <= bid price for a fill (for USDC bids)
        // But we also need to check No-backed bids at this level
        // For USDC bids: fill when bid_price >= min_price (taker's ask price)
        // For No-backed bids: fill when (100 - no_bid_price) >= min_price
        //   i.e., no_bid_price <= 100 - min_price

        // Check USDC bids first at this level
        if bid_price >= min_price {
            match_at_level_for_side(
                book, taker_side, SIDE_USDC_BID, bid_price, level_idx, result, max_fills, false,
            );
        }

        // No-backed bids: fill when (100 - no_bid_price) >= min_price,
        // i.e., no_bid_price <= (100 - min_price).
        let max_no_price = MERGE_TOTAL_CENTS.saturating_sub(min_price);
        if bid_price <= max_no_price {
            match_at_level_for_side(
                book, taker_side, SIDE_NO_BID, bid_price, level_idx, result, max_fills, true,
            );
        }
    }
}

/// Core matching at a price level — scans slots for active orders of the given side.
/// Uses time priority (lower slot index = earlier placement = higher priority).
fn match_at_level_for_side(
    book: &mut OrderBook,
    taker_side: u8,
    resting_side: u8,
    fill_price: u8,
    level_idx: usize,
    result: &mut MatchResult,
    max_fills: u8,
    is_merge: bool,
) {
    let level = &mut book.levels[level_idx];

    for slot_idx in 0..MAX_ORDERS_PER_LEVEL {
        if result.remaining_quantity < MIN_ORDER_SIZE {
            break;
        }
        if result.fills.len() >= max_fills as usize {
            break;
        }

        let order = &level.orders[slot_idx];
        if !order.active() {
            continue;
        }
        if order.side != resting_side {
            continue;
        }

        // Self-trade allowed per spec (documented limitation)

        // Calculate fill quantity
        let fill_qty = result.remaining_quantity.min(order.quantity);
        if fill_qty < MIN_ORDER_SIZE && fill_qty < order.quantity {
            // Don't create dust fills — skip if the remaining amount is below min
            // and wouldn't fully fill the resting order
            continue;
        }

        // Record the fill
        result.fills.push(Fill {
            maker: order.owner,
            maker_order_id: order.order_id,
            maker_side: resting_side,
            taker_side,
            price: fill_price,
            quantity: fill_qty,
            is_merge,
            price_level_idx: level_idx,
            slot_idx,
        });

        // Update the resting order
        let order_mut = &mut level.orders[slot_idx];
        if fill_qty >= order_mut.quantity {
            // Fully filled — deactivate
            order_mut.quantity = 0;
            order_mut.set_active(false);
            debug_assert!(level.count > 0);
            if level.count > 0 {
                level.count -= 1;
            }
        } else {
            // Partial fill — reduce quantity
            order_mut.quantity -= fill_qty;
        }

        result.remaining_quantity -= fill_qty;
    }
}

/// Place a resting order on the book at the given price level.
/// Returns Ok(order_id) on success, Err if the level is full.
pub fn place_resting_order(
    book: &mut OrderBook,
    owner: Pubkey,
    side: u8,
    price: u8,
    quantity: u64,
    original_quantity: u64,
    timestamp: i64,
) -> std::result::Result<u64, ()> {
    let level_idx = (price as usize).saturating_sub(1);
    if level_idx >= MAX_PRICE_LEVELS {
        return Err(());
    }

    let level = &mut book.levels[level_idx];

    // Find an empty slot
    let mut empty_slot: Option<usize> = None;
    for i in 0..MAX_ORDERS_PER_LEVEL {
        if !level.orders[i].active() {
            empty_slot = Some(i);
            break;
        }
    }

    let slot_idx = match empty_slot {
        Some(idx) => idx,
        None => return Err(()), // Level full
    };

    let order_id = book.next_order_id;
    book.next_order_id += 1;

    let order = &mut book.levels[level_idx].orders[slot_idx];
    order.owner = owner;
    order.order_id = order_id;
    order.quantity = quantity;
    order.original_quantity = original_quantity;
    order.side = side;
    order._side_padding = [0; 7];
    order.timestamp = timestamp;
    order.set_active(true);
    order._padding = [0; 7];

    book.levels[level_idx].count += 1;

    Ok(order_id)
}

/// Cancel a resting order by (price_level, order_id).
/// Returns the cancelled order's details if found and owned by the caller.
pub fn cancel_resting_order(
    book: &mut OrderBook,
    price: u8,
    order_id: u64,
    owner: &Pubkey,
) -> std::result::Result<CancelledOrder, CancelError> {
    let level_idx = (price as usize).saturating_sub(1);
    if level_idx >= MAX_PRICE_LEVELS {
        return Err(CancelError::NotFound);
    }

    let level = &mut book.levels[level_idx];

    for slot_idx in 0..MAX_ORDERS_PER_LEVEL {
        let order = &level.orders[slot_idx];
        if !order.active() {
            continue;
        }
        if order.order_id != order_id {
            continue;
        }

        // Found the order — check ownership
        if order.owner != *owner {
            return Err(CancelError::NotOwned);
        }

        let cancelled = CancelledOrder {
            owner: order.owner,
            order_id: order.order_id,
            side: order.side,
            quantity: order.quantity,
            price,
        };

        // Deactivate
        let order_mut = &mut level.orders[slot_idx];
        order_mut.set_active(false);
        order_mut.quantity = 0;
        debug_assert!(level.count > 0);
        if level.count > 0 {
            level.count -= 1;
        }

        return Ok(cancelled);
    }

    Err(CancelError::NotFound)
}

/// Details of a cancelled order
#[derive(Clone, Debug)]
pub struct CancelledOrder {
    pub owner: Pubkey,
    pub order_id: u64,
    pub side: u8,
    pub quantity: u64,
    pub price: u8,
}

/// Cancel error variants
#[derive(Clone, Debug, PartialEq)]
pub enum CancelError {
    NotFound,
    NotOwned,
}

/// Crank-cancel: iterate slots and cancel up to `batch_size` active orders.
/// Returns a list of cancelled orders for escrow refund processing.
pub fn crank_cancel_batch(
    book: &mut OrderBook,
    batch_size: usize,
) -> Vec<CancelledOrder> {
    let mut cancelled = Vec::new();

    for level_idx in 0..MAX_PRICE_LEVELS {
        if cancelled.len() >= batch_size {
            break;
        }

        let price = (level_idx + 1) as u8;
        let level = &mut book.levels[level_idx];

        for slot_idx in 0..MAX_ORDERS_PER_LEVEL {
            if cancelled.len() >= batch_size {
                break;
            }

            let order = &level.orders[slot_idx];
            if !order.active() {
                continue;
            }

            cancelled.push(CancelledOrder {
                owner: order.owner,
                order_id: order.order_id,
                side: order.side,
                quantity: order.quantity,
                price,
            });

            let order_mut = &mut level.orders[slot_idx];
            order_mut.set_active(false);
            order_mut.quantity = 0;
            debug_assert!(level.count > 0);
            if level.count > 0 {
                level.count -= 1;
            }
        }
    }

    cancelled
}

/// Check if the order book has any active orders.
pub fn has_active_orders(book: &OrderBook) -> bool {
    for level_idx in 0..MAX_PRICE_LEVELS {
        if book.levels[level_idx].count > 0 {
            return true;
        }
    }
    false
}
