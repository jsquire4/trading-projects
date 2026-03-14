use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Step 1 of two-step admin transfer: current admin proposes a new admin.
/// The proposed admin must call accept_admin to finalize.
pub fn handle_transfer_admin(
    ctx: Context<TransferAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = new_admin;

    msg!(
        "Admin transfer proposed: current={}, pending={}",
        ctx.accounts.admin.key(),
        new_admin,
    );

    Ok(())
}
