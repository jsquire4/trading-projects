use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct UpdateStrikeCreationFee<'info> {
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

/// Max strike creation fee: 1000 USDC (prevents accidental bricking)
const MAX_STRIKE_CREATION_FEE: u64 = 1_000_000_000;

pub fn handle_update_strike_creation_fee(
    ctx: Context<UpdateStrikeCreationFee>,
    new_fee: u64,
) -> Result<()> {
    require!(new_fee <= MAX_STRIKE_CREATION_FEE, MeridianError::FeeBpsOutOfRange);
    ctx.accounts.config.strike_creation_fee = new_fee;
    msg!(
        "Strike creation fee updated to {} by admin={}",
        new_fee,
        ctx.accounts.admin.key(),
    );
    Ok(())
}
