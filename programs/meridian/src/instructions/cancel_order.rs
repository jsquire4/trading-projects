use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::{cancel_resting_order, CancelError};
use crate::state::order_book::*;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = escrow_vault @ MeridianError::InvalidEscrow,
        has_one = yes_escrow @ MeridianError::InvalidEscrow,
        has_one = no_escrow @ MeridianError::InvalidEscrow,
        has_one = order_book @ MeridianError::InvalidOrderBook,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        constraint = order_book.load()?.market == market.key() @ MeridianError::InvalidMarket,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// USDC escrow vault — refund source for USDC bids
    #[account(mut)]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Yes token escrow — refund source for Yes asks
    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// No token escrow — refund source for No-backed bids
    #[account(mut)]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA (refund dest for side=0)
    #[account(
        mut,
        constraint = user_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = user_usdc_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA (refund dest for side=1)
    #[account(
        mut,
        constraint = user_yes_ata.mint == market.yes_mint @ MeridianError::InvalidMint,
        constraint = user_yes_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's No ATA (refund dest for side=2)
    #[account(
        mut,
        constraint = user_no_ata.mint == market.no_mint @ MeridianError::InvalidMint,
        constraint = user_no_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel_order(
    ctx: Context<CancelOrder>,
    price: u8,
    order_id: u64,
) -> Result<()> {
    // Note: Cancellation is intentionally allowed on settled/closed markets.
    // Users must be able to retrieve escrowed funds at any time.
    require!(price >= 1 && price <= 99, MeridianError::InvalidPrice);

    let mut ob = ctx.accounts.order_book.load_mut()?;
    let cancelled = cancel_resting_order(&mut ob, price, order_id, &ctx.accounts.user.key())
        .map_err(|e| match e {
            CancelError::NotFound => MeridianError::OrderNotFound,
            CancelError::NotOwned => MeridianError::OrderNotOwned,
        })?;

    drop(ob);

    // Build signer seeds for market PDA
    let market = &ctx.accounts.market;
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    // Refund based on order side
    match cancelled.side {
        SIDE_USDC_BID => {
            // Refund USDC: quantity was escrowed as quantity * price / 100
            let refund = cancelled
                .quantity
                .checked_mul(cancelled.price as u64)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_div(100)
                .ok_or(MeridianError::DivisionByZero)?;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.user_usdc_ata.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund,
            )?;
        }
        SIDE_YES_ASK => {
            // Refund Yes tokens
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: ctx.accounts.user_yes_ata.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer_seeds,
                ),
                cancelled.quantity,
            )?;
        }
        SIDE_NO_BID => {
            // Refund No tokens
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.no_escrow.to_account_info(),
                        to: ctx.accounts.user_no_ata.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer_seeds,
                ),
                cancelled.quantity,
            )?;
        }
        _ => return Err(MeridianError::InvalidSide.into()),
    }

    msg!(
        "Order cancelled: user={}, market={}, order_id={}, side={}, qty={}, price={}",
        ctx.accounts.user.key(),
        ctx.accounts.market.key(),
        order_id,
        cancelled.side,
        cancelled.quantity,
        price,
    );

    Ok(())
}
