use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

pub fn handle_unpause(ctx: Context<Unpause>) -> Result<()> {
    require!(ctx.accounts.config.is_paused, MeridianError::NotPaused);
    ctx.accounts.config.is_paused = false;
    msg!("Global pause deactivated by admin={}", ctx.accounts.admin.key());
    Ok(())
}
