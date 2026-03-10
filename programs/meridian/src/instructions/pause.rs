use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct Pause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// Optional: the market to pause. If not provided, pauses globally.
    #[account(mut)]
    pub market: Option<Account<'info, StrikeMarket>>,
}

pub fn handle_pause(ctx: Context<Pause>, _market: Option<Pubkey>) -> Result<()> {
    match &mut ctx.accounts.market {
        None => {
            // Global pause
            require!(!ctx.accounts.config.is_paused, MeridianError::AlreadyPaused);
            ctx.accounts.config.is_paused = true;
            msg!("Global pause activated by admin={}", ctx.accounts.admin.key());
        }
        Some(market) => {
            require!(
                market.config == ctx.accounts.config.key(),
                MeridianError::InvalidMarket
            );
            require!(!market.is_paused, MeridianError::AlreadyPaused);
            market.is_paused = true;
            msg!(
                "Market {} paused by admin={}",
                market.key(),
                ctx.accounts.admin.key()
            );
        }
    }

    Ok(())
}
