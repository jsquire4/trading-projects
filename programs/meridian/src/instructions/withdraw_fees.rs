use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// Fee vault USDC account (PDA-owned)
    #[account(
        mut,
        seeds = [GlobalConfig::FEE_VAULT_SEED],
        bump,
        constraint = fee_vault.mint == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    /// Admin's USDC ATA to receive fees
    #[account(
        mut,
        constraint = admin_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = admin_usdc_ata.owner == admin.key() @ MeridianError::SignerMismatch,
    )]
    pub admin_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Drain all accumulated fees from fee_vault to admin's USDC ATA.
pub fn handle_withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
    let amount = ctx.accounts.fee_vault.amount;

    require!(amount > 0, MeridianError::InsufficientBalance);

    config_signer_seeds!(ctx.accounts.config => bump_byte, seeds, signer_seeds);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.fee_vault.to_account_info(),
                to: ctx.accounts.admin_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    msg!(
        "Fees withdrawn: amount={}, admin={}",
        amount,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
