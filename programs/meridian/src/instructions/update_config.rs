use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Update configurable parameters on GlobalConfig.
/// Each field is optional — only provided values are updated.
pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    staleness_threshold: Option<u64>,
    settlement_staleness: Option<u64>,
    confidence_bps: Option<u64>,
    operating_reserve: Option<u64>,
    settlement_blackout_minutes: Option<u16>,
    slot_rent_markup: Option<u64>,
    override_window_secs: Option<u16>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(v) = staleness_threshold {
        require!(v > 0, MeridianError::InvalidStalenessThreshold);
        config.staleness_threshold = v;
    }

    if let Some(v) = settlement_staleness {
        require!(v > 0, MeridianError::InvalidStalenessThreshold);
        config.settlement_staleness = v;
    }

    if let Some(v) = confidence_bps {
        require!(v > 0 && v <= 10_000, MeridianError::InvalidConfidenceThreshold);
        config.confidence_bps = v;
    }

    if let Some(v) = operating_reserve {
        config.operating_reserve = v;
    }

    if let Some(v) = settlement_blackout_minutes {
        require!(v <= 60, MeridianError::InvalidBlackoutMinutes);
        config.settlement_blackout_minutes = v;
    }

    if let Some(v) = slot_rent_markup {
        // NOTE (M-7): slot_rent_markup is stored but not yet consumed by any
        // instruction. Reserved for future use: intended to cover per-order
        // lifecycle transaction fees charged at order placement.
        config.slot_rent_markup = v;
    }

    if let Some(v) = override_window_secs {
        require!(v >= 1 && v <= 3600, MeridianError::ArithmeticOverflow); // 1s to 1h
        config.override_window_secs = v;
    }

    msg!("Config updated by admin={}", ctx.accounts.admin.key());

    Ok(())
}
