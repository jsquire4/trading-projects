use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct UpdateFeeBps<'info> {
    #[account(
        constraint = admin.key() == config.admin @ MeridianError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handle_update_fee_bps(ctx: Context<UpdateFeeBps>, new_fee_bps: u16) -> Result<()> {
    require!(new_fee_bps <= 1000, MeridianError::FeeBpsOutOfRange);
    ctx.accounts.config.fee_bps = new_fee_bps;
    msg!(
        "Fee BPS updated to {} by admin={}",
        new_fee_bps,
        ctx.accounts.admin.key(),
    );
    Ok(())
}
