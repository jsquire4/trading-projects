use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::MatchResult;
use crate::state::order_book::*;
use super::PlaceOrder;

/// Transfers the taker's assets into the appropriate escrow account based on side.
pub(super) fn escrow_taker_assets(
    ctx: &Context<'_, '_, '_, '_, PlaceOrder<'_>>,
    side: u8,
    price: u8,
    quantity: u64,
) -> Result<()> {
    match side {
        SIDE_USDC_BID => {
            // Escrow USDC: cost = ceil(quantity * price / 100)
            let escrow_amount = quantity
                .checked_mul(price as u64)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_add(99)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_div(100)
                .ok_or(MeridianError::DivisionByZero)?;

            require!(
                ctx.accounts.user_usdc_ata.amount >= escrow_amount,
                MeridianError::InsufficientBalance
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc_ata.to_account_info(),
                        to: ctx.accounts.escrow_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                escrow_amount,
            )?;
        }
        SIDE_YES_ASK => {
            require!(
                ctx.accounts.user_yes_ata.amount >= quantity,
                MeridianError::InsufficientBalance
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_yes_ata.to_account_info(),
                        to: ctx.accounts.yes_escrow.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                quantity,
            )?;
        }
        SIDE_NO_BID => {
            require!(
                ctx.accounts.user_no_ata.amount >= quantity,
                MeridianError::InsufficientBalance
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_no_ata.to_account_info(),
                        to: ctx.accounts.no_escrow.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                quantity,
            )?;
        }
        _ => return Err(MeridianError::InvalidSide.into()),
    }

    Ok(())
}

/// Refunds unfilled escrow amounts back to the taker for market orders
/// and limit orders with dust remainders (below MIN_ORDER_SIZE).
#[allow(clippy::too_many_arguments)]
pub(super) fn refund_unfilled<'info>(
    match_result: &MatchResult,
    side: u8,
    price: u8,
    order_type: u8,
    ctx: &Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
    tp: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    escrow_ai: &AccountInfo<'info>,
    yes_escrow_ai: &AccountInfo<'info>,
    no_escrow_ai: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let unfilled = match_result.remaining_quantity;

    // Refund for: market orders (all unfilled) or limit orders with dust remainder
    let should_refund = (order_type == ORDER_TYPE_MARKET && unfilled > 0)
        || (order_type == ORDER_TYPE_LIMIT && unfilled > 0 && unfilled < MIN_ORDER_SIZE);

    if !should_refund {
        return Ok(());
    }

    match side {
        SIDE_USDC_BID => {
            // Ceiling division to match escrow deposit (ceil(qty * price / 100))
            let refund = unfilled
                .checked_mul(price as u64)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_add(99)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_div(100)
                .ok_or(MeridianError::DivisionByZero)?;
            if refund > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: escrow_ai.clone(),
                            to: ctx.accounts.user_usdc_ata.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    refund,
                )?;
            }
        }
        SIDE_YES_ASK => {
            if unfilled > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: yes_escrow_ai.clone(),
                            to: ctx.accounts.user_yes_ata.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    unfilled,
                )?;
            }
        }
        SIDE_NO_BID => {
            if unfilled > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.clone(),
                        Transfer {
                            from: no_escrow_ai.clone(),
                            to: ctx.accounts.user_no_ata.to_account_info(),
                            authority: market_ai.clone(),
                        },
                        signer_seeds,
                    ),
                    unfilled,
                )?;
            }
        }
        _ => {}
    }

    Ok(())
}
