use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, spl_token};

use crate::error::MeridianError;
use crate::matching::engine::crank_cancel_batch;
use crate::state::events::CrankCancelEvent;
use crate::state::order_book::*;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct CrankCancel<'info> {
    #[account(mut)]
    pub caller: Signer<'info>, // anyone can call

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        has_one = config @ MeridianError::InvalidMarket,
        has_one = escrow_vault @ MeridianError::InvalidEscrow,
        has_one = yes_escrow @ MeridianError::InvalidEscrow,
        has_one = no_escrow @ MeridianError::InvalidEscrow,
        has_one = order_book @ MeridianError::InvalidOrderBook,
        constraint = market.is_settled @ MeridianError::MarketNotSettled,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Sparse order book PDA — validated via market.order_book.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

    /// USDC escrow vault — refund source for USDC bids (side=0)
    #[account(mut)]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Yes token escrow — refund source for Yes asks (side=1)
    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// No token escrow — refund source for No-backed bids (side=2)
    #[account(mut)]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    // remaining_accounts: one owner token ATA per cancelled order
}

pub fn handle_crank_cancel<'info>(
    ctx: Context<'_, '_, '_, 'info, CrankCancel<'info>>,
    batch_size: u8,
) -> Result<()> {
    let ob_info = ctx.accounts.order_book.to_account_info();
    require!(
        ob_info.owner == ctx.program_id,
        MeridianError::InvalidOrderBook
    );

    // 1. Cancel up to batch_size resting orders
    let cancelled;
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        require!(
            verify_discriminator(&ob_data),
            MeridianError::OrderBookDiscriminatorMismatch
        );
        cancelled = crank_cancel_batch(&mut ob_data, batch_size.min(32) as usize);
    }

    // 2. If nothing to cancel, error out
    require!(!cancelled.is_empty(), MeridianError::CrankNotNeeded);

    // 3. Validate we have enough remaining_accounts
    require!(
        ctx.remaining_accounts.len() >= cancelled.len(),
        MeridianError::InsufficientAccounts
    );

    // 4. Build market PDA signer seeds
    let market = &ctx.accounts.market;
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    let tp = ctx.accounts.token_program.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();

    let usdc_mint = ctx.accounts.escrow_vault.mint;
    let yes_mint = ctx.accounts.yes_escrow.mint;
    let no_mint = ctx.accounts.no_escrow.mint;

    // 5. Process refunds
    for (i, order) in cancelled.iter().enumerate() {
        let dest = &ctx.remaining_accounts[i];

        // Validate destination
        require!(
            dest.owner == &spl_token::ID,
            MeridianError::InvalidProgramId
        );
        let dest_data = dest.try_borrow_data()?;
        require!(dest_data.len() >= 64, MeridianError::AccountNotInitialized);
        let dest_mint = Pubkey::new_from_array(dest_data[0..32].try_into().unwrap());
        let dest_owner = Pubkey::new_from_array(dest_data[32..64].try_into().unwrap());
        drop(dest_data);

        require!(dest_owner == order.owner, MeridianError::SignerMismatch);
        let expected_mint = match order.side {
            SIDE_USDC_BID => usdc_mint,
            SIDE_YES_ASK => yes_mint,
            SIDE_NO_BID => no_mint,
            _ => return Err(MeridianError::InvalidSide.into()),
        };
        require!(dest_mint == expected_mint, MeridianError::InvalidMint);

        match order.side {
            SIDE_USDC_BID => {
                let refund = order
                    .quantity
                    .checked_mul(order.price as u64)
                    .ok_or(MeridianError::ArithmeticOverflow)?
                    / 100;

                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: ctx.accounts.escrow_vault.to_account_info(),
                            to: dest.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    refund,
                )?;
            }
            SIDE_YES_ASK => {
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: ctx.accounts.yes_escrow.to_account_info(),
                            to: dest.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    order.quantity,
                )?;
            }
            SIDE_NO_BID => {
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: ctx.accounts.no_escrow.to_account_info(),
                            to: dest.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    order.quantity,
                )?;
            }
            _ => return Err(MeridianError::InvalidSide.into()),
        }
    }

    emit!(CrankCancelEvent {
        market: ctx.accounts.market.key(),
        cancelled_count: cancelled.len() as u32,
    });

    msg!(
        "Crank cancel: market={}, cancelled={} orders",
        ctx.accounts.market.key(),
        cancelled.len(),
    );

    Ok(())
}
