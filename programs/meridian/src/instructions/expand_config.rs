use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct ExpandConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Config PDA — cannot use Account<GlobalConfig> because the v2 struct
    /// is larger than the v1 account data. Validated manually: owner, seeds, admin field.
    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// One-time realloc GlobalConfig from 192 → 248 bytes to add v2 fields.
/// New fields are appended (preserving existing offsets):
///   pending_admin: Pubkey (+32)
///   operating_reserve: u64 (+8)
///   obligations: u64 (+8)
///   settlement_blackout_minutes: u16 (+2)
///   _padding2: [u8; 6] (+6)
///   = 56 additional bytes → 248 total
pub fn handle_expand_config(ctx: Context<ExpandConfig>) -> Result<()> {
    let config_info = &ctx.accounts.config;

    // Validate program ownership
    require!(
        config_info.owner == ctx.program_id,
        MeridianError::Unauthorized,
    );

    let current_size = config_info.data_len();

    // 8 (discriminator) + 192 (v1 data) = 200
    // 8 (discriminator) + 248 (v2 data) = 256
    let v1_total = 8 + GlobalConfig::V1_LEN; // 200
    let v2_total = 8 + GlobalConfig::LEN;     // 256

    require!(
        current_size == v1_total,
        MeridianError::ConfigAlreadyExpanded,
    );

    // Validate admin: admin pubkey is at offset 8 (after discriminator)
    {
        let data = config_info.try_borrow_data()?;
        require!(data.len() >= 40, MeridianError::Unauthorized);
        let stored_admin = Pubkey::try_from(&data[8..40]).unwrap();
        require!(
            stored_admin == ctx.accounts.admin.key(),
            MeridianError::Unauthorized,
        );
    }

    // Transfer lamports to cover rent increase
    let rent = Rent::get()?;
    let new_min_balance = rent.minimum_balance(v2_total);
    let current_lamports = config_info.lamports();
    let lamports_needed = new_min_balance.saturating_sub(current_lamports);

    if lamports_needed > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: config_info.to_account_info(),
                },
            ),
            lamports_needed,
        )?;
    }

    // Realloc and zero-fill new bytes
    config_info.realloc(v2_total, true)?;

    // New fields are zero-initialized by realloc(_, true):
    //   pending_admin = Pubkey::default() (all zeros)
    //   operating_reserve = 0
    //   obligations = 0
    //   settlement_blackout_minutes = 0
    //   _padding2 = [0; 6]

    msg!(
        "GlobalConfig expanded: {} → {} bytes, admin={}",
        current_size,
        v2_total,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
