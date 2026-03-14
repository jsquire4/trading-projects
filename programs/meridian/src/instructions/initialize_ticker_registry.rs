use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, TickerEntry, TickerRegistry};

#[derive(Accounts)]
pub struct InitializeTickerRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = admin,
        space = TickerRegistry::size_for(7), // Pre-allocate for MAG7
        seeds = [TickerRegistry::SEED_PREFIX],
        bump,
    )]
    pub ticker_registry: Box<Account<'info, TickerRegistry>>,

    pub system_program: Program<'info, System>,
}

/// Initialize the TickerRegistry PDA with the MAG7 tickers from GlobalConfig.
/// Called once after initialize_config + expand_config.
pub fn handle_initialize_ticker_registry(ctx: Context<InitializeTickerRegistry>) -> Result<()> {
    let config = &ctx.accounts.config;
    let registry = &mut ctx.accounts.ticker_registry;

    registry.bump = ctx.bumps.ticker_registry;
    registry._padding = [0u8; 7];

    // Seed with existing tickers from GlobalConfig
    let count = (config.ticker_count as usize).min(config.tickers.len());
    for i in 0..count {
        registry.entries.push(TickerEntry {
            ticker: config.tickers[i],
            is_active: true,
            pyth_feed: Pubkey::default(), // Will be set when switching to Pyth
            _padding: [0u8; 7],
        });
    }

    msg!(
        "TickerRegistry initialized with {} tickers, admin={}",
        count,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
