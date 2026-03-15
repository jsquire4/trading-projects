use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::order_book::*;
use crate::state::GlobalConfig;

/// StrikeMarket byte offsets for raw data manipulation.
/// Borsh layout: disc(8) + 9×Pubkey(288) + 8×u64(64) + alt_address(32) + ticker[8] + is_settled(1) + outcome(1) + is_paused(1)
/// is_paused is at offset 8 + 288 + 64 + 32 + 8 + 1 + 1 = 402
const SM_IS_PAUSED_OFFSET: usize = 8 + (9 * 32) + (8 * 8) + 32 + 8 + 1 + 1;

#[derive(Accounts)]
pub struct CircuitBreaker<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Mass pause + crank cancel resting orders on markets passed via remaining_accounts.
///
/// remaining_accounts layout: pairs of (market, order_book) accounts.
/// Each market is paused and its order book's resting orders are cancelled.
pub fn handle_circuit_breaker<'info>(
    ctx: Context<'_, '_, 'info, 'info, CircuitBreaker<'info>>,
) -> Result<()> {
    // Global pause
    if !ctx.accounts.config.is_paused {
        ctx.accounts.config.is_paused = true;
    }

    // Process remaining_accounts in (market, order_book) pairs
    let remaining = ctx.remaining_accounts;
    let pair_count = remaining.len() / 2;

    let mut markets_paused = 0u32;
    let mut orders_cancelled = 0u32;

    // Compute StrikeMarket discriminator for validation
    let sm_disc = &anchor_lang::solana_program::hash::hash(
        b"account:StrikeMarket",
    ).to_bytes()[..8];

    for i in 0..pair_count {
        let market_info = &remaining[i * 2];
        let book_info = &remaining[i * 2 + 1];

        // Validate market account: owned by this program + correct discriminator
        require!(
            market_info.owner == ctx.program_id,
            MeridianError::InvalidMarket,
        );
        {
            let data = market_info.try_borrow_data()?;
            require!(
                data.len() > SM_IS_PAUSED_OFFSET && data[..8] == *sm_disc,
                MeridianError::InvalidMarket,
            );
        }

        // Validate order book belongs to this market
        {
            let data = market_info.try_borrow_data()?;
            // order_book pubkey is at offset 8 + 7*32 = 232 (8th pubkey field)
            let stored_book = Pubkey::try_from(&data[8 + 7 * 32..8 + 8 * 32]).unwrap();
            require!(
                stored_book == book_info.key(),
                MeridianError::InvalidMarket,
            );
        }

        // Pause the market via raw byte write
        {
            let mut data = market_info.try_borrow_mut_data()?;
            if data[SM_IS_PAUSED_OFFSET] == 0 {
                data[SM_IS_PAUSED_OFFSET] = 1;
                markets_paused += 1;
            }
        }

        // Cancel resting orders in the order book (sparse layout)
        if book_info.owner == ctx.program_id && book_info.data_len() >= HEADER_SIZE {
            let mut ob_data = book_info.try_borrow_mut_data()?;
            if verify_discriminator(&ob_data) {
                let opl = ob_data[HDR_ORDERS_PER_LEVEL];
                for price_idx in 0..MAX_PRICE_LEVELS {
                    let level_idx = ob_data[HDR_PRICE_MAP + price_idx];
                    if level_idx == PRICE_UNALLOCATED { continue; }

                    for s in 0..opl {
                        if slot_is_active(&ob_data, level_idx, s) {
                            deactivate_slot(&mut ob_data, level_idx, s);
                            let cnt = level_count(&ob_data, level_idx);
                            if cnt > 0 {
                                set_level_count(&mut ob_data, level_idx, cnt - 1);
                            }
                            orders_cancelled += 1;
                        }
                    }
                }
            }
        }
    }

    msg!(
        "Circuit breaker activated: admin={}, markets_paused={}, orders_cancelled={}",
        ctx.accounts.admin.key(),
        markets_paused,
        orders_cancelled,
    );

    Ok(())
}
