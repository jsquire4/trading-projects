use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Step 2 of two-step admin transfer: proposed admin accepts authority.
pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Must have a pending admin proposal
    require!(
        config.pending_admin != Pubkey::default(),
        MeridianError::NoPendingAdmin,
    );

    // Signer must be the pending admin
    require!(
        ctx.accounts.new_admin.key() == config.pending_admin,
        MeridianError::NotPendingAdmin,
    );

    let old_admin = config.admin;
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();

    msg!(
        "Admin transfer accepted: old={}, new={}",
        old_admin,
        config.admin,
    );

    Ok(())
}
