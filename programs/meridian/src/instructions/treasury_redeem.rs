use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct TreasuryRedeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = yes_mint @ MeridianError::InvalidMint,
        has_one = no_mint @ MeridianError::InvalidMint,
        constraint = market.is_closed @ MeridianError::MarketNotClosed,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// Treasury USDC account (config PDA authority)
    #[account(
        mut,
        seeds = [GlobalConfig::TREASURY_SEED],
        bump,
        constraint = treasury.mint == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA
    #[account(
        mut,
        constraint = user_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = user_usdc_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's Yes token ATA
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's No token ATA
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_treasury_redeem(ctx: Context<TreasuryRedeem>) -> Result<()> {
    let market = &ctx.accounts.market;
    let outcome = market.outcome;

    let yes_balance = ctx.accounts.user_yes_ata.amount;
    let no_balance = ctx.accounts.user_no_ata.amount;

    // Nothing to redeem
    require!(
        yes_balance > 0 || no_balance > 0,
        MeridianError::NoTokensToRedeem,
    );

    // Calculate payouts:
    // 1. Pair burn: min(yes, no) → $1 per pair
    // 2. Winner remainder → $1 per token
    // 3. Loser remainder → $0 (just burn)
    let pair_count = yes_balance.min(no_balance);
    let yes_remainder = yes_balance.saturating_sub(pair_count);
    let no_remainder = no_balance.saturating_sub(pair_count);

    let winner_remainder = match outcome {
        1 => yes_remainder, // Yes wins
        2 => no_remainder,  // No wins
        _ => 0,
    };

    let total_payout = pair_count
        .checked_add(winner_remainder)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Check treasury has enough
    require!(
        ctx.accounts.treasury.amount >= total_payout,
        MeridianError::NoTreasuryFunds,
    );

    // Build config PDA signer seeds for treasury transfers
    config_signer_seeds!(ctx.accounts.config => bump_byte, seeds, signer_seeds);

    // Burn all Yes tokens the user holds
    if yes_balance > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.user_yes_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            yes_balance,
        )?;
    }

    // Burn all No tokens the user holds
    if no_balance > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.user_no_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            no_balance,
        )?;
    }

    // Transfer payout from treasury to user
    if total_payout > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            total_payout,
        )?;
    }

    // Update market total_redeemed (counts pairs redeemed, consistent with redeem.rs)
    let market = &mut ctx.accounts.market;
    market.total_redeemed = market
        .total_redeemed
        .checked_add(pair_count.checked_add(winner_remainder).ok_or(MeridianError::ArithmeticOverflow)?)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "Treasury redeem: user={}, market={}, yes_burned={}, no_burned={}, payout={}",
        ctx.accounts.user.key(),
        market.key(),
        yes_balance,
        no_balance,
        total_payout,
    );

    Ok(())
}
