use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut)]
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

    /// Admin's USDC ATA to receive surplus USDC
    #[account(
        mut,
        constraint = admin_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = admin_usdc_ata.owner == admin.key() @ MeridianError::SignerMismatch,
    )]
    pub admin_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: SOL Treasury PDA — for SOL withdrawals.
    /// Validated via config.sol_treasury.
    #[account(
        mut,
        constraint = sol_treasury.key() == config.sol_treasury @ MeridianError::InvalidVault,
    )]
    pub sol_treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Withdraw surplus from treasury.
/// mode=0: USDC — hard-capped at balance - obligations (on-chain enforced, no override)
/// mode=1: SOL — capped at balance - operating_reserve - rent_exempt_minimum
pub fn handle_withdraw_treasury(
    ctx: Context<WithdrawTreasury>,
    amount: u64,
    mode: u8,
) -> Result<()> {
    require!(amount > 0, MeridianError::InsufficientBalance);

    match mode {
        0 => withdraw_usdc(&ctx, amount),
        1 => withdraw_sol(&ctx, amount),
        _ => err!(MeridianError::InvalidSide),
    }
}

fn withdraw_usdc(ctx: &Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let treasury_balance = ctx.accounts.treasury.amount;

    // Hard cap: balance - obligations. No admin override.
    let available = treasury_balance.saturating_sub(config.obligations);
    require!(
        amount <= available,
        MeridianError::WithdrawalExceedsAvailable,
    );

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
        "USDC treasury withdrawal: amount={}, available={}, obligations={}, admin={}",
        amount,
        available,
        config.obligations,
        ctx.accounts.admin.key(),
    );

    Ok(())
}

fn withdraw_sol(ctx: &Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let sol_treasury_info = ctx.accounts.sol_treasury.to_account_info();
    let treasury_balance = sol_treasury_info.lamports();

    // Floor: rent-exempt minimum + operating_reserve
    let rent = Rent::get()?;
    let rent_exempt_min = rent.minimum_balance(0);
    let floor = rent_exempt_min.saturating_add(config.operating_reserve);
    let available = treasury_balance.saturating_sub(floor);

    require!(
        amount <= available,
        MeridianError::WithdrawalExceedsAvailable,
    );

    // Transfer SOL from treasury to admin via direct lamport manipulation
    **sol_treasury_info.try_borrow_mut_lamports()? = sol_treasury_info
        .lamports()
        .checked_sub(amount)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    **ctx.accounts.admin.try_borrow_mut_lamports()? = ctx.accounts.admin
        .lamports()
        .checked_add(amount)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "SOL treasury withdrawal: amount={}, available={}, reserve={}, admin={}",
        amount,
        available,
        config.operating_reserve,
        ctx.accounts.admin.key(),
    );

    Ok(())
}
