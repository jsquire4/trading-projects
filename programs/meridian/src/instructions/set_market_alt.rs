use anchor_lang::prelude::*;
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct SetMarketAlt<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        constraint = market.alt_address == Pubkey::default() @ MeridianError::AltAlreadySet,
    )]
    pub market: Account<'info, StrikeMarket>,
}

pub fn handle_set_market_alt(ctx: Context<SetMarketAlt>, alt_address: Pubkey) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.alt_address = alt_address;

    msg!("Market ALT set: market={}, alt={}", market.key(), alt_address);

    Ok(())
}
