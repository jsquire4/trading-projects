use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, spl_token};

use crate::error::MeridianError;
use crate::matching::engine::crank_cancel_batch;
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

    #[account(
        mut,
        constraint = order_book.load()?.market == market.key() @ MeridianError::InvalidMarket,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

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
    // 1. Load order book and cancel up to batch_size (max 32) resting orders
    let cancelled = {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let result = crank_cancel_batch(&mut ob, batch_size.min(32) as usize);
        result
    };

    // 2. If nothing to cancel, error out
    require!(!cancelled.is_empty(), MeridianError::CrankNotNeeded);

    // 3. Validate we have enough remaining_accounts (one per cancelled order)
    require!(
        ctx.remaining_accounts.len() >= cancelled.len(),
        MeridianError::InsufficientAccounts
    );

    // 4. Build market PDA signer seeds
    let market = &ctx.accounts.market;
    let strike_price_bytes = market.strike_price.to_le_bytes();
    let expiry_day = (market.market_close_unix / 86400) as u32;
    let expiry_day_bytes = expiry_day.to_le_bytes();
    let bump_slice = &[market.bump];

    let seeds: &[&[u8]] = &[
        StrikeMarket::SEED_PREFIX,
        market.ticker.as_ref(),
        &strike_price_bytes,
        &expiry_day_bytes,
        bump_slice,
    ];
    let signer_seeds = &[seeds];

    let tp = ctx.accounts.token_program.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();

    // Get the expected mints for validation
    let usdc_mint = ctx.accounts.escrow_vault.mint;
    let yes_mint = ctx.accounts.yes_escrow.mint;
    let no_mint = ctx.accounts.no_escrow.mint;

    // 5. For each cancelled order, transfer escrowed assets to the corresponding remaining_account
    for (i, order) in cancelled.iter().enumerate() {
        let dest = &ctx.remaining_accounts[i];

        // Validate destination is a token account owned by the original order placer
        // with the correct mint for the order side
        // SPL Token Account layout: mint(32) + owner(32) + amount(8) + ...
        require!(
            dest.owner == &spl_token::ID,
            MeridianError::InvalidProgramId
        );
        let dest_data = dest.try_borrow_data()?;
        require!(dest_data.len() >= 64, MeridianError::AccountNotInitialized);
        let dest_mint = Pubkey::new_from_array(dest_data[0..32].try_into().unwrap());
        let dest_owner = Pubkey::new_from_array(dest_data[32..64].try_into().unwrap());
        drop(dest_data);

        require!(
            dest_owner == order.owner,
            MeridianError::SignerMismatch
        );
        let expected_mint = match order.side {
            SIDE_USDC_BID => usdc_mint,
            SIDE_YES_ASK => yes_mint,
            SIDE_NO_BID => no_mint,
            _ => return Err(MeridianError::InvalidSide.into()),
        };
        require!(
            dest_mint == expected_mint,
            MeridianError::InvalidMint
        );

        match order.side {
            SIDE_USDC_BID => {
                // USDC bid: escrowed amount = quantity * price / 100
                let refund = order
                    .quantity
                    .checked_mul(order.price as u64)
                    .ok_or(MeridianError::ArithmeticOverflow)?
                    .checked_div(100)
                    .ok_or(MeridianError::DivisionByZero)?;

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
                // Yes ask: return Yes tokens
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
                // No-backed bid: return No tokens
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

    msg!(
        "Crank cancel: market={}, cancelled={} orders",
        ctx.accounts.market.key(),
        cancelled.len(),
    );

    Ok(())
}
