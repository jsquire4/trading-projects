use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, TickerRegistry};

#[derive(Accounts)]
pub struct DeactivateTicker<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [TickerRegistry::SEED_PREFIX],
        bump = ticker_registry.bump,
    )]
    pub ticker_registry: Box<Account<'info, TickerRegistry>>,
}

/// Admin-only: deactivate a ticker (moderation). New markets cannot be created
/// for deactivated tickers. Existing markets are unaffected.
pub fn handle_deactivate_ticker(
    ctx: Context<DeactivateTicker>,
    ticker: [u8; 8],
) -> Result<()> {
    let registry = &mut ctx.accounts.ticker_registry;

    let idx = registry
        .find_index(&ticker)
        .ok_or(MeridianError::TickerNotFound)?;

    require!(
        registry.entries[idx].is_active,
        MeridianError::TickerDeactivated,
    );

    registry.entries[idx].is_active = false;

    let ticker_str = core::str::from_utf8(&ticker)
        .unwrap_or("?")
        .trim_end_matches('\0');
    msg!(
        "Ticker deactivated: {}, admin={}",
        ticker_str,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
