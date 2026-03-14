use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// Treasury USDC account (config PDA authority)
    #[account(
        mut,
        seeds = [GlobalConfig::TREASURY_SEED],
        bump,
        constraint = treasury.mint == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Admin's USDC ATA to receive surplus
    #[account(
        mut,
        constraint = admin_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = admin_usdc_ata.owner == admin.key() @ MeridianError::SignerMismatch,
    )]
    pub admin_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Withdraw surplus USDC from treasury.
/// Guard: amount <= treasury.balance - obligations - operating_reserve
pub fn handle_withdraw_treasury(
    ctx: Context<WithdrawTreasury>,
    amount: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let treasury_balance = ctx.accounts.treasury.amount;

    // Calculate available = balance - obligations - operating_reserve
    let locked = config
        .obligations
        .checked_add(config.operating_reserve)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    let available = treasury_balance.saturating_sub(locked);

    require!(
        amount <= available,
        MeridianError::WithdrawalExceedsAvailable,
    );

    require!(amount > 0, MeridianError::InsufficientBalance);

    config_signer_seeds!(config => bump_byte, seeds, signer_seeds);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.admin_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    msg!(
        "Treasury withdrawal: amount={}, available={}, obligations={}, reserve={}, admin={}",
        amount,
        available,
        config.obligations,
        config.operating_reserve,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
