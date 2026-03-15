use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct CircuitBreaker<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Global emergency stop. Semantically distinct from `pause` — this is intended
/// for automated/urgent triggers whereas `pause` is a deliberate admin action.
/// Both instructions are kept as separate entry points (different semantic meaning),
/// but delegate to the same shared core logic to avoid duplication.
pub fn handle_circuit_breaker(
    ctx: Context<CircuitBreaker>,
) -> Result<()> {
    msg!("Circuit breaker activated: admin={}", ctx.accounts.admin.key());
    // Delegate to shared core logic — identical to handle_pause body.
    do_pause(&mut ctx.accounts.config)
}

/// Shared core: set is_paused = true. Called by both pause and circuit_breaker.
pub(crate) fn do_pause(config: &mut GlobalConfig) -> Result<()> {
    require!(!config.is_paused, MeridianError::AlreadyPaused);
    config.is_paused = true;
    Ok(())
}
