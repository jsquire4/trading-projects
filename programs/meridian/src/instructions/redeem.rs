use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !config.is_paused @ MeridianError::MarketPaused,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = yes_mint @ MeridianError::InvalidMint,
        has_one = no_mint @ MeridianError::InvalidMint,
        has_one = usdc_vault @ MeridianError::InvalidVault,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA — payout destination
    #[account(
        mut,
        constraint = user_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = user_usdc_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's No ATA
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_redeem(ctx: Context<Redeem>, mode: u8, quantity: u64) -> Result<()> {
    require!(quantity >= 1_000_000, MeridianError::InvalidQuantity);

    match mode {
        0 => handle_pair_burn(ctx, quantity),
        1 => handle_winner_redeem(ctx, quantity),
        _ => err!(MeridianError::InvalidRedemptionMode),
    }
}

/// Mode 0: Pair burn — burns 1 Yes + 1 No, returns $1 USDC. Available anytime.
fn handle_pair_burn(ctx: Context<Redeem>, quantity: u64) -> Result<()> {
    // Require user holds enough of BOTH tokens
    require!(
        ctx.accounts.user_yes_ata.amount >= quantity,
        MeridianError::InsufficientBalance
    );
    require!(
        ctx.accounts.user_no_ata.amount >= quantity,
        MeridianError::InsufficientBalance
    );

    // Verify vault can cover the payout
    require!(
        ctx.accounts.usdc_vault.amount >= quantity,
        MeridianError::InsufficientVaultBalance
    );

    // Ring-fence: if market is settled with a winner, ensure vault retains enough
    // for outstanding winning token holders after this burn withdrawal.
    // Pair burn reduces both vault AND winning supply by `quantity` (burns Yes + No equally),
    // so we compare post-burn vault against post-burn winning supply.
    let market = &ctx.accounts.market;
    if market.is_settled && market.outcome > 0 {
        let winning_supply = match market.outcome {
            1 => ctx.accounts.yes_mint.supply,
            2 => ctx.accounts.no_mint.supply,
            _ => 0,
        };
        let vault_after_burn = ctx
            .accounts
            .usdc_vault
            .amount
            .checked_sub(quantity)
            .ok_or(MeridianError::ArithmeticOverflow)?;
        let winning_supply_after_burn = winning_supply
            .checked_sub(quantity)
            .ok_or(MeridianError::ArithmeticOverflow)?;
        require!(
            vault_after_burn >= winning_supply_after_burn,
            MeridianError::InsufficientVaultBalance
        );
    }

    // Build market PDA signer seeds
    let market = &ctx.accounts.market;
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    let market_key = market.key();

    // Burn Yes tokens (user is authority over their own ATA)
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        quantity,
    )?;

    // Burn No tokens
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        quantity,
    )?;

    // Transfer USDC from vault to user (market PDA signs as vault authority)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        quantity,
    )?;

    // Update market state
    let market = &mut ctx.accounts.market;
    market.total_redeemed = market
        .total_redeemed
        .checked_add(quantity)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Pair burn removes one Yes + one No token from circulation.
    // For settled markets, this reduces outstanding obligations (which were
    // set to total_minted - total_redeemed at settlement time). For unsettled
    // markets, obligations is 0 and saturating_sub is a no-op — correct
    // because settlement will compute a smaller outstanding value since
    // total_redeemed was already incremented above.
    let config = &mut ctx.accounts.config;
    config.obligations = config.obligations.saturating_sub(quantity);

    msg!(
        "Pair burn redeemed: user={}, market={}, quantity={}, total_redeemed={}, obligations={}",
        ctx.accounts.user.key(),
        market_key,
        quantity,
        market.total_redeemed,
        config.obligations,
    );

    Ok(())
}

/// Mode 1: Winner redemption — after settlement, winners get $1 per token.
fn handle_winner_redeem(ctx: Context<Redeem>, quantity: u64) -> Result<()> {
    let market = &ctx.accounts.market;

    // Must be settled
    require!(market.is_settled, MeridianError::MarketNotSettled);

    // Must be past override window
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= market.override_deadline,
        MeridianError::RedemptionBlockedOverride
    );

    // Determine which token to burn based on outcome
    let (burn_mint, burn_ata, user_balance) = match market.outcome {
        1 => (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_yes_ata.to_account_info(),
            ctx.accounts.user_yes_ata.amount,
        ),
        2 => (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_no_ata.to_account_info(),
            ctx.accounts.user_no_ata.amount,
        ),
        _ => return err!(MeridianError::InvalidOutcome),
    };

    // Require user holds enough winning tokens
    require!(user_balance >= quantity, MeridianError::InsufficientBalance);

    // Verify vault can cover the payout
    require!(
        ctx.accounts.usdc_vault.amount >= quantity,
        MeridianError::InsufficientVaultBalance
    );

    // Build market PDA signer seeds
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    let market_key = market.key();
    let outcome = market.outcome;

    // Burn winning tokens (user is authority over their own ATA)
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: burn_mint,
                from: burn_ata,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        quantity,
    )?;

    // Transfer USDC payout from vault to user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        quantity,
    )?;

    // Update market state
    let market = &mut ctx.accounts.market;
    market.total_redeemed = market
        .total_redeemed
        .checked_add(quantity)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Decrement obligations (winner redemption reduces outstanding USDC owed)
    let config = &mut ctx.accounts.config;
    config.obligations = config.obligations.saturating_sub(quantity);

    msg!(
        "Winner redeemed: user={}, market={}, outcome={}, quantity={}, total_redeemed={}",
        ctx.accounts.user.key(),
        market_key,
        outcome,
        quantity,
        market.total_redeemed,
    );

    Ok(())
}
