/// Matching engine — pure functions for price-time priority order matching.
///
/// Sparse layout with variable-size levels: each price level has its own
/// slot_count (starts at 1, grows dynamically). The price_map stores u16
/// byte offsets (0xFFFF = unallocated).

use anchor_lang::prelude::*;
use crate::state::order_book::*;

/// The total price in cents for a Yes+No pair (always $1.00 = 100 cents).
const MERGE_TOTAL_CENTS: u8 = 100;

/// Result of a single fill during matching
#[derive(Clone, Debug)]
pub struct Fill {
    pub maker: Pubkey,
    pub maker_order_id: u64,
    pub maker_side: u8,
    pub taker_side: u8,
    pub price: u8,
    pub quantity: u64,
    pub is_merge: bool,
    /// Level byte offset (internal use)
    pub level_idx: u8,
    /// Slot index within the price level
    pub slot_idx: u8,
}

/// Result of running the matching engine
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub fills: Vec<Fill>,
    pub remaining_quantity: u64,
    pub resting_failed: bool,
}

/// Error from place_resting_order
#[derive(Clone, Debug, PartialEq)]
pub enum PlaceError {
    NeedsNewLevel,
    LevelFull,
    OrderIdOverflow,
}

/// Match a new order against the book.
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
        SIDE_USDC_BID => {
            match_against_asks_with_cap(data, taker_side, price, &mut result, max_fills, false);
        }
        SIDE_YES_ASK => {
            match_against_bids(data, taker_side, price, &mut result, max_fills);
        }
        SIDE_NO_BID => {
            let max_yes_ask = MERGE_TOTAL_CENTS.saturating_sub(price);
            match_against_asks_with_cap(data, taker_side, max_yes_ask, &mut result, max_fills, true);
        }
        _ => {}
    }

    result
}

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

        let loff = book_price_map(data, ask_price);
        if loff == PRICE_UNALLOCATED { continue; }
        let loff = loff as usize;

        match_at_level_for_side(
            data, taker_side, SIDE_YES_ASK, ask_price, loff, result, max_fills, is_merge,
        );
    }
}

fn match_against_bids(
    data: &mut [u8],
    taker_side: u8,
    min_price: u8,
    result: &mut MatchResult,
    max_fills: u8,
) {
    for price_idx in (0..MAX_PRICE_LEVELS).rev() {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        let bid_price = (price_idx + 1) as u8;

        let loff = book_price_map(data, bid_price);
        if loff == PRICE_UNALLOCATED { continue; }
        let loff = loff as usize;

        let match_usdc = bid_price >= min_price;
        let max_no_price = MERGE_TOTAL_CENTS.saturating_sub(min_price);
        let match_no = bid_price <= max_no_price;

        // Match both USDC_BID and NO_BID at this level with proper FIFO.
        // match_at_level_for_side already picks the earliest-timestamp order
        // within a single side. To interleave across sides, we call it once
        // per fill and let the timestamp-based selection handle priority.
        if match_usdc && !match_no {
            match_at_level_for_side(
                data, taker_side, SIDE_USDC_BID, bid_price, loff, result, max_fills, false,
            );
        } else if match_no && !match_usdc {
            match_at_level_for_side(
                data, taker_side, SIDE_NO_BID, bid_price, loff, result, max_fills, true,
            );
        } else if match_usdc && match_no {
            // Both sides eligible — use combined FIFO matching that considers
            // both USDC_BID and NO_BID orders by timestamp at this level.
            match_at_level_both_sides(
                data, taker_side, bid_price, loff, result, max_fills,
            );
        }
    }
}

/// Combined FIFO matching across both USDC_BID and NO_BID at a single level.
/// Picks the order with the earliest timestamp regardless of side.
fn match_at_level_both_sides(
    data: &mut [u8],
    taker_side: u8,
    fill_price: u8,
    loff: usize,
    result: &mut MatchResult,
    max_fills: u8,
) {
    let slot_cnt = level_slot_count(data, loff);

    loop {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        // Find the earliest active order across both USDC_BID and NO_BID
        let mut best_slot: Option<u8> = None;
        let mut best_ts: i64 = i64::MAX;
        let mut best_side: u8 = 0;

        for s in 0..slot_cnt {
            if !slot_is_active(data, loff, s) { continue; }
            let s_side = slot_side(data, loff, s);
            if s_side != SIDE_USDC_BID && s_side != SIDE_NO_BID { continue; }
            let ts = slot_timestamp(data, loff, s);
            if ts < best_ts {
                best_ts = ts;
                best_slot = Some(s);
                best_side = s_side;
            }
        }

        let s = match best_slot {
            Some(idx) => idx,
            None => break,
        };

        let is_merge = best_side == SIDE_NO_BID;
        let order_qty = slot_quantity(data, loff, s);
        let fill_qty = result.remaining_quantity.min(order_qty);

        result.fills.push(Fill {
            maker: slot_owner(data, loff, s),
            maker_order_id: slot_order_id(data, loff, s),
            maker_side: best_side,
            taker_side,
            price: fill_price,
            quantity: fill_qty,
            is_merge,
            level_idx: 0,
            slot_idx: s,
        });

        if fill_qty >= order_qty {
            deactivate_slot(data, loff, s);
            let cnt = level_count(data, loff);
            if cnt > 0 {
                set_level_count(data, loff, cnt - 1);
            }
        } else {
            set_slot_quantity(data, loff, s, order_qty - fill_qty);
        }

        result.remaining_quantity -= fill_qty;
    }
}

/// Core matching at a price level — uses per-level slot_count.
fn match_at_level_for_side(
    data: &mut [u8],
    taker_side: u8,
    resting_side: u8,
    fill_price: u8,
    loff: usize,
    result: &mut MatchResult,
    max_fills: u8,
    is_merge: bool,
) {
    let slot_cnt = level_slot_count(data, loff);

    loop {
        if result.remaining_quantity < MIN_ORDER_SIZE { break; }
        if result.fills.len() >= max_fills as usize { break; }

        // Find the active order with the lowest timestamp (FIFO priority)
        let mut best_slot: Option<u8> = None;
        let mut best_ts: i64 = i64::MAX;

        for s in 0..slot_cnt {
            if !slot_is_active(data, loff, s) { continue; }
            if slot_side(data, loff, s) != resting_side { continue; }
            let ts = slot_timestamp(data, loff, s);
            if ts < best_ts {
                best_ts = ts;
                best_slot = Some(s);
            }
        }

        let s = match best_slot {
            Some(idx) => idx,
            None => break,
        };

        let order_qty = slot_quantity(data, loff, s);
        let fill_qty = result.remaining_quantity.min(order_qty);

        result.fills.push(Fill {
            maker: slot_owner(data, loff, s),
            maker_order_id: slot_order_id(data, loff, s),
            maker_side: resting_side,
            taker_side,
            price: fill_price,
            quantity: fill_qty,
            is_merge,
            level_idx: 0, // unused externally
            slot_idx: s,
        });

        if fill_qty >= order_qty {
            deactivate_slot(data, loff, s);
            let cnt = level_count(data, loff);
            if cnt > 0 {
                set_level_count(data, loff, cnt - 1);
            }
        } else {
            set_slot_quantity(data, loff, s, order_qty - fill_qty);
        }

        result.remaining_quantity -= fill_qty;
    }
}

/// Place a resting order on the book at the given price level.
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
    let loff_u16 = book_price_map(data, price);
    if loff_u16 == PRICE_UNALLOCATED {
        return Err(PlaceError::NeedsNewLevel);
    }
    let loff = loff_u16 as usize;

    let slot_cnt = level_slot_count(data, loff);

    // Find an empty slot
    let mut empty_slot: Option<u8> = None;
    for s in 0..slot_cnt {
        if !slot_is_active(data, loff, s) {
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
    write_order_slot(data, loff, s, owner, order_id, quantity, original_quantity, side, timestamp, rent_depositor);

    // Increment active count
    let cnt = level_count(data, loff);
    set_level_count(data, loff, cnt + 1);

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

    let loff_u16 = book_price_map(data, price);
    if loff_u16 == PRICE_UNALLOCATED {
        return Err(CancelError::NotFound);
    }
    let loff = loff_u16 as usize;

    let slot_cnt = level_slot_count(data, loff);

    for s in 0..slot_cnt {
        if !slot_is_active(data, loff, s) { continue; }
        if slot_order_id(data, loff, s) != order_id { continue; }

        let slot_owner_key = slot_owner(data, loff, s);
        if slot_owner_key != *owner {
            return Err(CancelError::NotOwned);
        }

        let cancelled = CancelledOrder {
            owner: slot_owner_key,
            order_id,
            side: slot_side(data, loff, s),
            quantity: slot_quantity(data, loff, s),
            price,
            rent_depositor: slot_rent_depositor(data, loff, s),
            level_idx: 0, // unused
        };

        deactivate_slot(data, loff, s);
        let cnt = level_count(data, loff);
        if cnt > 0 {
            set_level_count(data, loff, cnt - 1);
        }

        return Ok(cancelled);
    }

    Err(CancelError::NotFound)
}

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

#[derive(Clone, Debug, PartialEq)]
pub enum CancelError {
    NotFound,
    NotOwned,
}

/// Crank-cancel: iterate all levels and cancel up to `batch_size` active orders.
pub fn crank_cancel_batch(
    data: &mut [u8],
    batch_size: usize,
) -> Vec<CancelledOrder> {
    let mut cancelled = Vec::new();

    for price_idx in 0..MAX_PRICE_LEVELS {
        if cancelled.len() >= batch_size { break; }

        let price = (price_idx + 1) as u8;
        let loff_u16 = book_price_map(data, price);
        if loff_u16 == PRICE_UNALLOCATED { continue; }
        let loff = loff_u16 as usize;

        let slot_cnt = level_slot_count(data, loff);

        for s in 0..slot_cnt {
            if cancelled.len() >= batch_size { break; }
            if !slot_is_active(data, loff, s) { continue; }

            cancelled.push(CancelledOrder {
                owner: slot_owner(data, loff, s),
                order_id: slot_order_id(data, loff, s),
                side: slot_side(data, loff, s),
                quantity: slot_quantity(data, loff, s),
                price,
                rent_depositor: slot_rent_depositor(data, loff, s),
                level_idx: 0,
            });

            deactivate_slot(data, loff, s);
            let cnt = level_count(data, loff);
            if cnt > 0 {
                set_level_count(data, loff, cnt - 1);
            }
        }

        // Free level if all slots are now inactive (L-2 fix)
        if level_count(data, loff) == 0 {
            free_level(data, loff);
        }
    }

    cancelled
}

/// Check if the order book has any active orders.
pub fn has_active_orders(data: &[u8]) -> bool {
    for price_idx in 0..MAX_PRICE_LEVELS {
        let price = (price_idx + 1) as u8;
        let loff_u16 = book_price_map(data, price);
        if loff_u16 == PRICE_UNALLOCATED { continue; }
        if level_count(data, loff_u16 as usize) > 0 {
            return true;
        }
    }
    false
}

/// Count active orders without modifying the book (read-only).
pub fn count_active_orders(data: &[u8]) -> u32 {
    let mut count = 0u32;

    for price_idx in 0..MAX_PRICE_LEVELS {
        let price = (price_idx + 1) as u8;
        let loff_u16 = book_price_map(data, price);
        if loff_u16 == PRICE_UNALLOCATED { continue; }
        let loff = loff_u16 as usize;
        let slot_cnt = level_slot_count(data, loff);

        for s in 0..slot_cnt {
            if slot_is_active(data, loff, s) {
                count += 1;
            }
        }
    }

    count
}

pub fn deactivate_all_orders(data: &mut [u8]) -> u32 {
    let mut count = 0u32;

    for price_idx in 0..MAX_PRICE_LEVELS {
        let price = (price_idx + 1) as u8;
        let loff_u16 = book_price_map(data, price);
        if loff_u16 == PRICE_UNALLOCATED { continue; }
        let loff = loff_u16 as usize;
        let slot_cnt = level_slot_count(data, loff);

        for s in 0..slot_cnt {
            if slot_is_active(data, loff, s) {
                deactivate_slot(data, loff, s);
                let cnt = level_count(data, loff);
                if cnt > 0 {
                    set_level_count(data, loff, cnt - 1);
                }
                count += 1;
            }
        }
    }

    count
}
