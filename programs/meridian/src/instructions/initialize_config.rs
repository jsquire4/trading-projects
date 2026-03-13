use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::error::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::LEN,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    /// Mock USDC mint (or real USDC on mainnet)
    pub usdc_mint: Account<'info, Mint>,

    /// Treasury USDC account owned by config PDA — receives unclaimed USDC from force-closed markets
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = config,
        seeds = [GlobalConfig::TREASURY_SEED],
        bump,
    )]
    pub treasury: Account<'info, TokenAccount>,

    /// Fee vault USDC account owned by config PDA — receives protocol fees from fills
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = config,
        seeds = [GlobalConfig::FEE_VAULT_SEED],
        bump,
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    /// CHECK: Oracle program ID — validated by admin, stored for future CPI checks
    pub oracle_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    tickers: [[u8; 8]; 7],
    ticker_count: u8,
    staleness_threshold: u64,
    settlement_staleness: u64,
    confidence_bps: u64,
    oracle_type: u8,
) -> Result<()> {
    require!(ticker_count > 0 && ticker_count <= 7, MeridianError::InvalidTicker);
    require!(staleness_threshold > 0, MeridianError::InvalidStalenessThreshold);
    require!(settlement_staleness > 0, MeridianError::InvalidStalenessThreshold);
    require!(
        confidence_bps > 0 && confidence_bps <= 10_000,
        MeridianError::InvalidConfidenceThreshold
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.oracle_program = ctx.accounts.oracle_program.key();
    config.staleness_threshold = staleness_threshold;
    config.settlement_staleness = settlement_staleness;
    config.confidence_bps = confidence_bps;
    config.is_paused = false;
    config.oracle_type = oracle_type;
    config.tickers = tickers;
    config.ticker_count = ticker_count;
    config.bump = ctx.bumps.config;
    config.fee_bps = 0;
    config._padding = [0; 2];
    config.strike_creation_fee = 0;

    msg!(
        "GlobalConfig initialized: admin={}, usdc_mint={}, oracle_program={}, tickers={}",
        config.admin,
        config.usdc_mint,
        config.oracle_program,
        config.ticker_count,
    );

    Ok(())
}
