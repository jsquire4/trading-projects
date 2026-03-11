use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !config.is_paused @ MeridianError::MarketPaused,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = yes_mint @ MeridianError::InvalidMint,
        has_one = no_mint @ MeridianError::InvalidMint,
        has_one = usdc_vault @ MeridianError::InvalidVault,
        constraint = !market.is_settled @ MeridianError::MarketAlreadySettled,
        constraint = !market.is_paused @ MeridianError::MarketPaused,
        constraint = !market.is_closed @ MeridianError::MarketClosed,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's USDC token account — source of deposit
    #[account(
        mut,
        constraint = user_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = user_usdc_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's Yes token account — created if needed. Position constraint: must be 0.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's No token account — created if needed. Must have zero balance (checked in handler).
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    /// USDC collateral vault
    #[account(mut)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_mint_pair(ctx: Context<MintPair>, quantity: u64) -> Result<()> {
    // Validate quantity (in token lamports — 1 token = 1_000_000)
    require!(quantity >= 1_000_000, MeridianError::InvalidQuantity);

    // Reject minting after market close
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < ctx.accounts.market.market_close_unix,
        MeridianError::MarketClosed
    );

    // Position constraint: user must not hold Yes tokens (checked after ATA init)
    // The Yes ATA may have just been created (balance 0) — that's fine.
    // If user already held Yes tokens, this rejects.
    // reload() ensures fresh balances in composable transactions (matches place_order.rs pattern).
    ctx.accounts.user_yes_ata.reload()?;
    require!(
        ctx.accounts.user_yes_ata.amount == 0,
        MeridianError::ConflictingPosition
    );

    ctx.accounts.user_no_ata.reload()?;
    require!(
        ctx.accounts.user_no_ata.amount == 0,
        MeridianError::ConflictingPosition
    );

    // Calculate USDC deposit: 1 USDC per pair (quantity is in token lamports with 6 decimals)
    let usdc_amount = quantity; // 1:1 ratio — 1_000_000 token lamports = $1 = 1_000_000 USDC lamports

    // Verify user has sufficient USDC
    require!(
        ctx.accounts.user_usdc_ata.amount >= usdc_amount,
        MeridianError::InsufficientBalance
    );

    // Transfer USDC from user to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Build signer seeds for market PDA (mint authority)
    let market = &ctx.accounts.market;
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    let market_key = market.key();

    // Mint Yes tokens to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        quantity,
    )?;

    // Mint No tokens to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        quantity,
    )?;

    // Update market state
    let market = &mut ctx.accounts.market;
    market.total_minted = market
        .total_minted
        .checked_add(quantity)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "Pair minted: user={}, market={}, quantity={}, total_minted={}",
        ctx.accounts.user.key(),
        market_key,
        quantity,
        market.total_minted,
    );

    Ok(())
}
