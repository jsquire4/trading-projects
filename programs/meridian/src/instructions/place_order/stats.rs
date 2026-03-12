use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::matching::engine::MatchResult;
use crate::state::order_book::*;
use crate::state::StrikeMarket;

/// Updates market statistics after fill processing. Accumulates merge/burn quantities
/// into total_redeemed and enforces that market orders must fill at least partially.
pub(super) fn update_market_stats(
    market: &mut Account<'_, StrikeMarket>,
    match_result: &MatchResult,
    order_type: u8,
) -> Result<()> {
    let total_merged: u64 = match_result
        .fills
        .iter()
        .filter(|f| f.is_merge)
        .map(|f| f.quantity)
        .try_fold(0u64, |acc, q| acc.checked_add(q))
        .ok_or(MeridianError::ArithmeticOverflow)?;

    if total_merged > 0 {
        market.total_redeemed = market
            .total_redeemed
            .checked_add(total_merged)
            .ok_or(MeridianError::ArithmeticOverflow)?;
    }

    let total_filled: u64 = match_result
        .fills
        .iter()
        .map(|f| f.quantity)
        .try_fold(0u64, |acc, q| acc.checked_add(q))
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Market orders must fill at least partially
    require!(
        total_filled > 0 || order_type == ORDER_TYPE_LIMIT,
        MeridianError::NoFillsAvailable
    );

    Ok(())
}
