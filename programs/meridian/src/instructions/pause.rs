use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;
use crate::instructions::circuit_breaker::do_pause;

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
    msg!("Global pause activated by admin={}", ctx.accounts.admin.key());
    // Delegate to shared core logic — also used by circuit_breaker.
    do_pause(&mut ctx.accounts.config)
}
