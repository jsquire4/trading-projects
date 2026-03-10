use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// Optional: the market to unpause. If not provided, unpauses globally.
    #[account(mut)]
    pub market: Option<Account<'info, StrikeMarket>>,
}

pub fn handle_unpause(ctx: Context<Unpause>, _market: Option<Pubkey>) -> Result<()> {
    match &mut ctx.accounts.market {
        None => {
            require!(ctx.accounts.config.is_paused, MeridianError::NotPaused);
            ctx.accounts.config.is_paused = false;
            msg!("Global pause deactivated by admin={}", ctx.accounts.admin.key());
        }
        Some(market) => {
            require!(
                market.config == ctx.accounts.config.key(),
                MeridianError::InvalidMarket
            );
            require!(market.is_paused, MeridianError::NotPaused);
            market.is_paused = false;
            msg!(
                "Market {} unpaused by admin={}",
                market.key(),
                ctx.accounts.admin.key()
            );
        }
    }

    Ok(())
}
