use anchor_lang::prelude::*;
use anchor_spl::token;

use crate::error::MeridianError;
use crate::state::order_book::*;
use super::PlaceOrder;

/// Validates order parameters: side, price, quantity, and order type.
/// Pure function — no account context needed.
pub fn validate_order_params(side: u8, price: u8, quantity: u64, order_type: u8) -> Result<()> {
    require!(
        side == SIDE_USDC_BID || side == SIDE_YES_ASK || side == SIDE_NO_BID,
        MeridianError::InvalidSide
    );
    require!(price >= 1 && price <= 99, MeridianError::InvalidPrice);
    require!(quantity >= MIN_ORDER_SIZE, MeridianError::InvalidQuantity);
    require!(
        order_type == ORDER_TYPE_MARKET || order_type == ORDER_TYPE_LIMIT,
        MeridianError::InvalidOrderType
    );

    Ok(())
}

/// Checks that the current clock time is before the market close.
pub fn validate_market_time(ctx: &Context<'_, '_, '_, '_, PlaceOrder<'_>>, clock: &Clock) -> Result<()> {
    require!(
        clock.unix_timestamp < ctx.accounts.market.market_close_unix,
        MeridianError::MarketClosed
    );

    Ok(())
}

/// Validates that a maker account is a valid SPL token account owned by the expected maker.
/// Deduplicates the ownership check that was previously inlined 4 times.
pub fn validate_maker_account(maker_account: &AccountInfo, expected_maker: Pubkey) -> Result<()> {
    require!(
        maker_account.owner == &token::ID && {
            let data = maker_account.try_borrow_data()?;
            data.len() >= 64 && Pubkey::new_from_array(data[32..64].try_into().unwrap()) == expected_maker
        },
        MeridianError::InvalidMakerAccount
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_order_params_valid() {
        assert!(validate_order_params(SIDE_USDC_BID, 50, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_ok());
        assert!(validate_order_params(SIDE_YES_ASK, 1, MIN_ORDER_SIZE, ORDER_TYPE_MARKET).is_ok());
        assert!(validate_order_params(SIDE_NO_BID, 99, MIN_ORDER_SIZE * 2, ORDER_TYPE_LIMIT).is_ok());
    }

    #[test]
    fn test_validate_order_params_invalid_side() {
        assert!(validate_order_params(3, 50, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_err());
        assert!(validate_order_params(255, 50, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_err());
    }

    #[test]
    fn test_validate_order_params_invalid_price() {
        assert!(validate_order_params(SIDE_USDC_BID, 0, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_err());
        assert!(validate_order_params(SIDE_USDC_BID, 100, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_err());
        assert!(validate_order_params(SIDE_USDC_BID, 255, MIN_ORDER_SIZE, ORDER_TYPE_LIMIT).is_err());
    }

    #[test]
    fn test_validate_order_params_invalid_quantity() {
        assert!(validate_order_params(SIDE_USDC_BID, 50, 0, ORDER_TYPE_LIMIT).is_err());
        assert!(validate_order_params(SIDE_USDC_BID, 50, MIN_ORDER_SIZE - 1, ORDER_TYPE_LIMIT).is_err());
    }

    #[test]
    fn test_validate_order_params_invalid_order_type() {
        assert!(validate_order_params(SIDE_USDC_BID, 50, MIN_ORDER_SIZE, 2).is_err());
        assert!(validate_order_params(SIDE_USDC_BID, 50, MIN_ORDER_SIZE, 255).is_err());
    }
}
