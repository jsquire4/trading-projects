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

/// Global emergency stop. Sets config.is_paused = true.
/// All market creation, minting, and trading are blocked.
/// Users can still cancel resting orders.
/// End-of-day settlement lifecycle fires regardless of pause.
pub fn handle_circuit_breaker(
    ctx: Context<CircuitBreaker>,
) -> Result<()> {
    require!(!ctx.accounts.config.is_paused, MeridianError::AlreadyPaused);
    ctx.accounts.config.is_paused = true;

    msg!(
        "Circuit breaker activated: admin={}",
        ctx.accounts.admin.key(),
    );

    Ok(())
}
