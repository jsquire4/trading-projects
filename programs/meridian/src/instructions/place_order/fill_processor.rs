use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::{Fill, MatchResult};
use crate::state::events::FillEvent;
use crate::state::order_book::*;
use super::validate::validate_maker_account;

/// Compute per-side fee using u128 intermediate to prevent overflow.
/// Returns floor(gross * fee_bps / 10_000).
fn compute_fee(gross: u64, fee_bps: u16) -> Result<u64> {
    if fee_bps == 0 {
        return Ok(0);
    }
    let fee = ((gross as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        / 10_000u128) as u64;
    Ok(fee)
}

/// Transfer fee to fee_vault if amount > 0. Skips CPI when zero.
fn transfer_fee<'info>(
    amount: u64,
    tp: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    fee_vault_ai: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            Transfer {
                from: from.clone(),
                to: fee_vault_ai.clone(),
                authority: authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )?;
    Ok(())
}

/// Processes all fills from the matching engine, executing token transfers/burns
/// and emitting FillEvents. Returns the accumulated price improvement refund amount.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_fills<'info>(
    match_result: &MatchResult,
    side: u8,
    price: u8,
    market_key: Pubkey,
    taker_key: Pubkey,
    timestamp: i64,
    remaining_accounts: &[AccountInfo<'info>],
    tp: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    escrow_ai: &AccountInfo<'info>,
    yes_escrow_ai: &AccountInfo<'info>,
    no_escrow_ai: &AccountInfo<'info>,
    vault_ai: &AccountInfo<'info>,
    yes_mint_ai: &AccountInfo<'info>,
    no_mint_ai: &AccountInfo<'info>,
    user_usdc_ai: &AccountInfo<'info>,
    user_yes_ai: &AccountInfo<'info>,
    fee_vault_ai: &AccountInfo<'info>,
    fee_bps: u16,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    let mut rem_idx: usize = 0;
    let mut price_improvement_refund: u64 = 0;

    for fill in &match_result.fills {
        let fill_fee;

        if fill.is_merge {
            fill_fee = process_merge_fill(
                fill,
                side,
                fee_bps,
                remaining_accounts,
                &mut rem_idx,
                tp,
                market_ai,
                yes_escrow_ai,
                no_escrow_ai,
                vault_ai,
                yes_mint_ai,
                no_mint_ai,
                user_usdc_ai,
                fee_vault_ai,
                signer_seeds,
            )?;
        } else {
            let (improvement, fee) = process_swap_fill(
                fill,
                side,
                price,
                fee_bps,
                remaining_accounts,
                &mut rem_idx,
                tp,
                market_ai,
                escrow_ai,
                yes_escrow_ai,
                user_usdc_ai,
                user_yes_ai,
                fee_vault_ai,
                signer_seeds,
            )?;
            fill_fee = fee;
            price_improvement_refund = price_improvement_refund
                .checked_add(improvement)
                .ok_or(MeridianError::ArithmeticOverflow)?;
        }

        // Emit FillEvent
        emit!(FillEvent {
            market: market_key,
            maker: fill.maker,
            taker: taker_key,
            price: fill.price,
            quantity: fill.quantity,
            maker_side: fill.maker_side,
            taker_side: fill.taker_side,
            is_merge: fill.is_merge,
            maker_order_id: fill.maker_order_id,
            timestamp,
            fee: fill_fee,
        });
    }

    Ok(price_improvement_refund)
}

/// Processes a single merge/burn fill: burns Yes and No tokens from escrow,
/// then distributes USDC payouts to taker and maker (minus fees).
/// Returns the total fee collected.
#[allow(clippy::too_many_arguments)]
fn process_merge_fill<'info>(
    fill: &Fill,
    side: u8,
    fee_bps: u16,
    remaining_accounts: &[AccountInfo<'info>],
    rem_idx: &mut usize,
    tp: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    yes_escrow_ai: &AccountInfo<'info>,
    no_escrow_ai: &AccountInfo<'info>,
    vault_ai: &AccountInfo<'info>,
    yes_mint_ai: &AccountInfo<'info>,
    no_mint_ai: &AccountInfo<'info>,
    user_usdc_ai: &AccountInfo<'info>,
    fee_vault_ai: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    // Gross payout = fill.quantity ($1 per token pair from vault)
    // Fee is off the top: total_fee = floor(gross_payout * fee_bps / 10_000)
    let total_fee = compute_fee(fill.quantity, fee_bps)?;

    let net_payout = fill.quantity
        .checked_sub(total_fee)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    let yes_payout_per_unit = (fill.price as u64)
        .checked_mul(PRICE_TO_USDC_LAMPORTS)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    let no_payout_per_unit = USDC_LAMPORTS_PER_DOLLAR
        .checked_sub(yes_payout_per_unit)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    let mut yes_payout = (net_payout as u128)
        .checked_mul(yes_payout_per_unit as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;
    let no_payout = (net_payout as u128)
        .checked_mul(no_payout_per_unit as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;

    // Assign any truncation dust to yes_payout so no USDC is trapped in vault
    let total_distributed = yes_payout
        .checked_add(no_payout)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    let dust = net_payout.checked_sub(total_distributed).unwrap_or(0);
    if dust > 0 {
        yes_payout = yes_payout.checked_add(dust).ok_or(MeridianError::ArithmeticOverflow)?;
    }

    // Burn Yes from yes_escrow
    token::burn(
        CpiContext::new_with_signer(
            tp.clone(),
            Burn {
                mint: yes_mint_ai.clone(),
                from: yes_escrow_ai.clone(),
                authority: market_ai.clone(),
            },
            signer_seeds,
        ),
        fill.quantity,
    )?;

    // Burn No from no_escrow
    token::burn(
        CpiContext::new_with_signer(
            tp.clone(),
            Burn {
                mint: no_mint_ai.clone(),
                from: no_escrow_ai.clone(),
                authority: market_ai.clone(),
            },
            signer_seeds,
        ),
        fill.quantity,
    )?;

    // Transfer fee to fee_vault (from usdc_vault which holds the $1)
    transfer_fee(total_fee, tp, vault_ai, fee_vault_ai, market_ai, signer_seeds)?;

    if side == SIDE_NO_BID {
        // Taker = No seller -> gets no_payout from vault
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: vault_ai.clone(),
                    to: user_usdc_ai.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            no_payout,
        )?;

        // Maker = Yes seller -> gets yes_payout
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_usdc = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
        validate_maker_account(maker_usdc, fill.maker)?;
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: vault_ai.clone(),
                    to: maker_usdc.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            yes_payout,
        )?;
    } else {
        // taker_side == SIDE_YES_ASK, maker_side == SIDE_NO_BID
        // Taker = Yes seller -> gets no_payout from vault
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: vault_ai.clone(),
                    to: user_usdc_ai.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            no_payout,
        )?;

        // Maker = No seller -> gets yes_payout
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_usdc = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
        validate_maker_account(maker_usdc, fill.maker)?;
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: vault_ai.clone(),
                    to: maker_usdc.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            yes_payout,
        )?;
    }

    Ok(total_fee)
}

/// Processes a single standard swap fill. Returns (price_improvement, fee).
#[allow(clippy::too_many_arguments)]
fn process_swap_fill<'info>(
    fill: &Fill,
    side: u8,
    price: u8,
    fee_bps: u16,
    remaining_accounts: &[AccountInfo<'info>],
    rem_idx: &mut usize,
    tp: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    escrow_ai: &AccountInfo<'info>,
    yes_escrow_ai: &AccountInfo<'info>,
    user_usdc_ai: &AccountInfo<'info>,
    user_yes_ai: &AccountInfo<'info>,
    fee_vault_ai: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<(u64, u64)> {
    let fill_usdc = (fill.quantity as u128)
        .checked_mul(fill.price as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_mul(PRICE_TO_USDC_LAMPORTS as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;

    // Fee: single fee on the gross USDC amount, deducted from USDC flow
    let total_fee = compute_fee(fill_usdc, fee_bps)?;
    let net_usdc = fill_usdc
        .checked_sub(total_fee)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    let mut improvement: u64 = 0;

    if side == SIDE_USDC_BID {
        // Taker buys Yes. Maker had Yes ask in yes_escrow.
        // Yes from yes_escrow -> taker
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: yes_escrow_ai.clone(),
                    to: user_yes_ai.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            fill.quantity,
        )?;

        // USDC from escrow_vault -> maker (net of fee)
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_usdc = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
        validate_maker_account(maker_usdc, fill.maker)?;
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: escrow_ai.clone(),
                    to: maker_usdc.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            net_usdc,
        )?;

        // Transfer fee from escrow to fee_vault
        transfer_fee(total_fee, tp, escrow_ai, fee_vault_ai, market_ai, signer_seeds)?;

        // Price improvement: taker escrowed at `price` but filled at `fill.price`
        if fill.price < price {
            improvement = (fill.quantity as u128)
                .checked_mul((price - fill.price) as u128)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_mul(PRICE_TO_USDC_LAMPORTS as u128)
                .ok_or(MeridianError::ArithmeticOverflow)?
                .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
                .ok_or(MeridianError::DivisionByZero)? as u64;
        }
    } else if side == SIDE_YES_ASK {
        // Taker sells Yes. Maker had USDC bid in escrow_vault.
        // USDC from escrow -> taker (net of fee)
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: escrow_ai.clone(),
                    to: user_usdc_ai.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            net_usdc,
        )?;

        // Transfer fee from escrow to fee_vault
        transfer_fee(total_fee, tp, escrow_ai, fee_vault_ai, market_ai, signer_seeds)?;

        // Yes from yes_escrow -> maker
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_yes = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
        validate_maker_account(maker_yes, fill.maker)?;
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: yes_escrow_ai.clone(),
                    to: maker_yes.clone(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            fill.quantity,
        )?;
    }

    Ok((improvement, total_fee))
}
