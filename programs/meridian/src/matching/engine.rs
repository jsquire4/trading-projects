/// Matching engine — pure functions for price-time priority order matching.
///
/// Handles two settlement paths:
/// - Standard swap: USDC bid (side=0) matched with Yes ask (side=1)
/// - Merge/burn: No-backed bid (side=2) matched with Yes ask (side=1)
///
/// The engine never touches accounts directly — it operates on raw order book
/// byte data and returns fill results for the instruction handler to execute.
///
/// Sparse layout: levels are indexed via price_map[0..99]. Only allocated
/// levels are scanned, skipping 0xFF (unallocated) entries.

use anchor_lang::prelude::*;
use crate::state::order_book::*;

/// The total price in cents for a Yes+No pair (always $1.00 = 100 cents).
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
    /// Level index in sparse layout
    pub level_idx: u8,
    /// Slot index within the price level
    pub slot_idx: u8,
}

/// Result of running the matching engine
#[derive(Clone, Debug)]
pub struct MatchResult {
    /// Fills that occurred
    pub fills: Vec<Fill>,
    /// Remaining quantity that wasn't filled
    pub remaining_quantity: u64,
    /// True if the resting order placement failed
    pub resting_failed: bool,
}

/// Error from place_resting_order
#[derive(Clone, Debug, PartialEq)]
pub enum PlaceError {
    /// Price level not allocated — caller must realloc
    NeedsNewLevel,
    /// All slots at this level are full
    LevelFull,
    /// Order ID overflow
    OrderIdOverflow,
}

/// Match a new order against the book. Does NOT place a resting order —
/// the caller (instruction handler) handles that separately so it can
/// realloc if needed.
pub fn match_against_book(
    data: &mut [u8],
    taker_side: u8,
    price: u8,
    quantity: u64,
    max_fills: u8,
) -> MatchResult {
    let mut result = MatchResult {
        fills: Vec::new(),
        remaining_quantity: quantity,
        resting_failed: false,
    };

    match taker_side {
        // USDC bid (Buy Yes) — matches against Yes asks (side=1)
        SIDE_USDC_BID => {
            match_against_asks_with_cap(data, taker_side, price, &mut result, max_fills, false);
        }
        // Yes ask (Sell Yes) — matches against USDC bids (side=0) AND No-backed bids (side=2)
        SIDE_YES_ASK => {
            match_against_bids(data, taker_side, price, &mut result, max_fills);
        }
        // No-backed bid (Sell No) — matches against Yes asks (side=1)
        SIDE_NO_BID => {
            let max_yes_ask = MERGE_TOTAL_CENTS.saturating_sub(price);
            match_against_asks_with_cap(data, taker_side, max_yes_ask, &mut result, max_fills, true);
        }
        _ => {}
    }

    result
}

/// Match against Yes asks, walking prices from 1 upward up to `price_cap`.
/// Used for both standard swap (USDC bid, is_merge=false) and merge/burn
/// (No-backed bid, is_merge=true). The only difference between the two
/// callers was the price cap calculation and the is_merge flag.
fn match_against_asks_with_cap(
    data: &mut [u8],
    taker_side: u8,
    price_cap: u8,
    result: &mut MatchResult,
    max_fills: u8,
    is_merge: bool,
) {
    for price_idx in 0..MAX_PRICE_LEVELS {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        let ask_price = (price_idx + 1) as u8;
        if ask_price > price_cap { break; }

        let level_idx = data[HDR_PRICE_MAP + price_idx];
        if level_idx == PRICE_UNALLOCATED { continue; }

        match_at_level_for_side(
            data, taker_side, SIDE_YES_ASK, ask_price, level_idx, result, max_fills, is_merge,
        );
    }
}

/// Match a Yes ask against both USDC bids and No-backed bids.
fn match_against_bids(
    data: &mut [u8],
    taker_side: u8,
    min_price: u8,
    result: &mut MatchResult,
    max_fills: u8,
) {
    // Walk prices from 99 downward
    for price_idx in (0..MAX_PRICE_LEVELS).rev() {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        let bid_price = (price_idx + 1) as u8;

        let level_idx = data[HDR_PRICE_MAP + price_idx];
        if level_idx == PRICE_UNALLOCATED { continue; }

        // USDC bids at this level
        if bid_price >= min_price {
            match_at_level_for_side(
                data, taker_side, SIDE_USDC_BID, bid_price, level_idx, result, max_fills, false,
            );
        }

        // No-backed bids: fill when (100 - no_bid_price) >= min_price
        let max_no_price = MERGE_TOTAL_CENTS.saturating_sub(min_price);
        if bid_price <= max_no_price {
            match_at_level_for_side(
                data, taker_side, SIDE_NO_BID, bid_price, level_idx, result, max_fills, true,
            );
        }
    }
}

/// Core matching at a price level — scans slots for active orders of the given side.
/// Uses FIFO time priority: finds the oldest active order first.
fn match_at_level_for_side(
    data: &mut [u8],
    taker_side: u8,
    resting_side: u8,
    fill_price: u8,
    level_idx: u8,
    result: &mut MatchResult,
    max_fills: u8,
    is_merge: bool,
) {
    let opl = data[HDR_ORDERS_PER_LEVEL];

    loop {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        // Find the active order with the lowest timestamp (FIFO priority)
        let mut best_slot: Option<u8> = None;
        let mut best_ts: i64 = i64::MAX;

        for s in 0..opl {
            if !slot_is_active(data, level_idx, s) { continue; }
            if slot_side(data, level_idx, s) != resting_side { continue; }
            let ts = slot_timestamp(data, level_idx, s);
            if ts < best_ts {
                best_ts = ts;
                best_slot = Some(s);
            }
        }

        let s = match best_slot {
            Some(idx) => idx,
            None => break,
        };

        let order_qty = slot_quantity(data, level_idx, s);
        let fill_qty = result.remaining_quantity.min(order_qty);

        result.fills.push(Fill {
            maker: slot_owner(data, level_idx, s),
            maker_order_id: slot_order_id(data, level_idx, s),
            maker_side: resting_side,
            taker_side,
            price: fill_price,
            quantity: fill_qty,
            is_merge,
            level_idx,
            slot_idx: s,
        });

        // Update the resting order
        if fill_qty >= order_qty {
            // Fully filled — deactivate
            deactivate_slot(data, level_idx, s);
            let cnt = level_count(data, level_idx);
            if cnt > 0 {
                set_level_count(data, level_idx, cnt - 1);
            }
        } else {
            // Partial fill
            set_slot_quantity(data, level_idx, s, order_qty - fill_qty);
        }

        result.remaining_quantity -= fill_qty;
    }
}

/// Place a resting order on the book at the given price level.
/// Returns Ok(order_id) on success. The caller must ensure the level exists
/// (allocate via realloc before calling if price_map shows unallocated).
pub fn place_resting_order(
    data: &mut [u8],
    owner: &Pubkey,
    side: u8,
    price: u8,
    quantity: u64,
    original_quantity: u64,
    timestamp: i64,
    rent_depositor: &Pubkey,
) -> std::result::Result<u64, PlaceError> {
    // Look up level for this price
    let level_idx = book_price_map(data, price);
    if level_idx == PRICE_UNALLOCATED {
        return Err(PlaceError::NeedsNewLevel);
    }

    let opl = data[HDR_ORDERS_PER_LEVEL];

    // Find an empty slot
    let mut empty_slot: Option<u8> = None;
    for s in 0..opl {
        if !slot_is_active(data, level_idx, s) {
            empty_slot = Some(s);
            break;
        }
    }

    let s = match empty_slot {
        Some(idx) => idx,
        None => return Err(PlaceError::LevelFull),
    };

    // Allocate order ID
    let order_id = book_next_order_id(data);
    let next = order_id.checked_add(1).ok_or(PlaceError::OrderIdOverflow)?;
    write_u64(data, HDR_NEXT_ORDER_ID, next);

    // Write the order
    write_order_slot(data, level_idx, s, owner, order_id, quantity, original_quantity, side, timestamp, rent_depositor);

    // Increment level count
    let cnt = level_count(data, level_idx);
    set_level_count(data, level_idx, cnt + 1);

    Ok(order_id)
}

/// Cancel a resting order by (price, order_id).
pub fn cancel_resting_order(
    data: &mut [u8],
    price: u8,
    order_id: u64,
    owner: &Pubkey,
) -> std::result::Result<CancelledOrder, CancelError> {
    if price < 1 || price > 99 {
        return Err(CancelError::NotFound);
    }

    let level_idx = book_price_map(data, price);
    if level_idx == PRICE_UNALLOCATED {
        return Err(CancelError::NotFound);
    }

    let opl = data[HDR_ORDERS_PER_LEVEL];

    for s in 0..opl {
        if !slot_is_active(data, level_idx, s) { continue; }
        if slot_order_id(data, level_idx, s) != order_id { continue; }

        // Found — check ownership
        let slot_owner_key = slot_owner(data, level_idx, s);
        if slot_owner_key != *owner {
            return Err(CancelError::NotOwned);
        }

        let cancelled = CancelledOrder {
            owner: slot_owner_key,
            order_id,
            side: slot_side(data, level_idx, s),
            quantity: slot_quantity(data, level_idx, s),
            price,
            rent_depositor: slot_rent_depositor(data, level_idx, s),
            level_idx,
        };

        // Deactivate
        deactivate_slot(data, level_idx, s);
        let cnt = level_count(data, level_idx);
        if cnt > 0 {
            set_level_count(data, level_idx, cnt - 1);
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
    pub rent_depositor: Pubkey,
    pub level_idx: u8,
}

/// Cancel error variants
#[derive(Clone, Debug, PartialEq)]
pub enum CancelError {
    NotFound,
    NotOwned,
}

/// Crank-cancel: iterate slots and cancel up to `batch_size` active orders.
pub fn crank_cancel_batch(
    data: &mut [u8],
    batch_size: usize,
) -> Vec<CancelledOrder> {
    let mut cancelled = Vec::new();
    let opl = data[HDR_ORDERS_PER_LEVEL];

    // Walk price_map for allocated levels
    for price_idx in 0..MAX_PRICE_LEVELS {
        if cancelled.len() >= batch_size { break; }

        let level_idx = data[HDR_PRICE_MAP + price_idx];
        if level_idx == PRICE_UNALLOCATED { continue; }

        let price = (price_idx + 1) as u8;

        for s in 0..opl {
            if cancelled.len() >= batch_size { break; }
            if !slot_is_active(data, level_idx, s) { continue; }

            cancelled.push(CancelledOrder {
                owner: slot_owner(data, level_idx, s),
                order_id: slot_order_id(data, level_idx, s),
                side: slot_side(data, level_idx, s),
                quantity: slot_quantity(data, level_idx, s),
                price,
                rent_depositor: slot_rent_depositor(data, level_idx, s),
                level_idx,
            });

            deactivate_slot(data, level_idx, s);
            let cnt = level_count(data, level_idx);
            if cnt > 0 {
                set_level_count(data, level_idx, cnt - 1);
            }
        }
    }

    cancelled
}

/// Check if the order book has any active orders.
pub fn has_active_orders(data: &[u8]) -> bool {
    for price_idx in 0..MAX_PRICE_LEVELS {
        let level_idx = data[HDR_PRICE_MAP + price_idx];
        if level_idx == PRICE_UNALLOCATED { continue; }
        if level_count(data, level_idx) > 0 {
            return true;
        }
    }
    false
}

/// Deactivate all active order slots across all price levels.
/// Returns the number of orders deactivated.
/// Used by circuit_breaker to mass-cancel without collecting CancelledOrder details.
pub fn deactivate_all_orders(data: &mut [u8]) -> u32 {
    let opl = data[HDR_ORDERS_PER_LEVEL];
    let mut count = 0u32;

    for price_idx in 0..MAX_PRICE_LEVELS {
        let level_idx = data[HDR_PRICE_MAP + price_idx];
        if level_idx == PRICE_UNALLOCATED { continue; }

        for s in 0..opl {
            if slot_is_active(data, level_idx, s) {
                deactivate_slot(data, level_idx, s);
                let cnt = level_count(data, level_idx);
                if cnt > 0 {
                    set_level_count(data, level_idx, cnt - 1);
                }
                count += 1;
            }
        }
    }

    count
}
