use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct AdminOverrideSettlement<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        constraint = market.is_settled @ MeridianError::MarketNotSettled,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,
}

pub fn handle_admin_override_settlement(
    ctx: Context<AdminOverrideSettlement>,
    new_settlement_price: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // Ensure we are still within the override window
    require!(
        clock.unix_timestamp < market.override_deadline,
        MeridianError::OverrideWindowExpired
    );

    // Ensure we have not exceeded the maximum number of overrides
    require!(
        market.override_count < 3,
        MeridianError::MaxOverridesExceeded
    );

    // Reject zero price and cap at $1M (same invariants as admin_settle)
    require!(new_settlement_price > 0, MeridianError::OraclePriceInvalid);
    require!(new_settlement_price <= 1_000_000_000_000, MeridianError::OraclePriceInvalid);

    // Determine the new outcome: 1 = Yes wins, 2 = No wins
    let new_outcome: u8 = if new_settlement_price >= market.strike_price {
        1
    } else {
        2
    };

    let config = &ctx.accounts.config;
    let old_outcome = market.outcome;
    let old_price = market.settlement_price;

    // Apply the override
    market.settlement_price = new_settlement_price;
    market.outcome = new_outcome;
    // Cap total extension: settled_at + override_window * (override_count + 2)
    let override_window = config.override_window();
    let deadline_multiplier = (market.override_count as i64)
        .checked_add(2)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    market.override_deadline = market
        .settled_at
        .checked_add(
            override_window
                .checked_mul(deadline_multiplier)
                .ok_or(MeridianError::ArithmeticOverflow)?,
        )
        .ok_or(MeridianError::ArithmeticOverflow)?;
    market.override_count += 1;

    msg!(
        "Admin override settlement: market={}, old_price={}, new_price={}, old_outcome={}, new_outcome={}, override_count={}, new_deadline={}",
        market.key(),
        old_price,
        new_settlement_price,
        old_outcome,
        new_outcome,
        market.override_count,
        market.override_deadline
    );

    Ok(())
}
