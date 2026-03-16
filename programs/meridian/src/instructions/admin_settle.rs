use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct AdminSettle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        constraint = !market.is_settled @ MeridianError::MarketAlreadySettled,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,
}

pub fn handle_admin_settle(ctx: Context<AdminSettle>, settlement_price: u64) -> Result<()> {
    require!(settlement_price > 0, MeridianError::OraclePriceInvalid);
    // Sanity cap: settlement price must be realistic (max $1M per share = 1_000_000_000_000 lamports)
    require!(settlement_price <= 1_000_000_000_000, MeridianError::OraclePriceInvalid);

    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;

    let config = &ctx.accounts.config;

    // Admin settle delay: 0 for Mock oracle (admin IS the oracle), 1hr for Pyth
    let earliest_admin_settle = market
        .market_close_unix
        .checked_add(config.admin_settle_delay())
        .ok_or(MeridianError::ArithmeticOverflow)?;

    require!(
        clock.unix_timestamp >= earliest_admin_settle,
        MeridianError::AdminSettleTooEarly
    );

    // Determine outcome: settlement_price >= strike_price → Yes wins (1), else No wins (2)
    let outcome: u8 = if settlement_price >= market.strike_price {
        1 // Yes wins
    } else {
        2 // No wins
    };

    let settled_at = clock.unix_timestamp;
    let override_deadline = settled_at
        .checked_add(config.override_window())
        .ok_or(MeridianError::ArithmeticOverflow)?;

    market.is_settled = true;
    market.outcome = outcome;
    market.settlement_price = settlement_price;
    market.settled_at = settled_at;
    market.override_deadline = override_deadline;

    // Track obligations: winning token supply owed to holders (same as settle_market)
    let outstanding = market.total_minted
        .checked_sub(market.total_redeemed)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    let config = &mut ctx.accounts.config;
    config.obligations = config.obligations
        .checked_add(outstanding)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "Admin settled market {} | price={} strike={} outcome={} settled_at={} override_deadline={}",
        market.key(),
        settlement_price,
        market.strike_price,
        outcome,
        settled_at,
        override_deadline,
    );

    Ok(())
}
