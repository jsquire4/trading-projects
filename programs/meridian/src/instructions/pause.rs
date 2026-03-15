use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct Pause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

pub fn handle_pause(ctx: Context<Pause>) -> Result<()> {
    require!(!ctx.accounts.config.is_paused, MeridianError::AlreadyPaused);
    ctx.accounts.config.is_paused = true;
    msg!("Global pause activated by admin={}", ctx.accounts.admin.key());
    Ok(())
}
