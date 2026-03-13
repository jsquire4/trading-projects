use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use crate::error::MeridianError;
use crate::state::{OrderBook, StrikeMarket};

/// Total space for the OrderBook account (discriminator + data).
const ORDER_BOOK_TOTAL_SPACE: usize = 8 + OrderBook::LEN; // 254,288

/// Maximum growth per instruction (Solana runtime limit).
const MAX_GROWTH: usize = 10_240;

/// Incrementally allocate the OrderBook PDA.
///
/// The OrderBook (~248KB) exceeds Solana's 10KB CPI data increase limit,
/// so it cannot be created in a single instruction. This instruction
/// handles both initial creation and incremental growth:
///
///   - First call:  creates the PDA via `create_account` (up to 10KB)
///   - Next calls:  grows via `realloc` by up to 10KB each
///   - Final call:  no-op once full size is reached
///
/// Call this ~25 times before `create_strike_market`.
/// Multiple calls can be batched into 2-3 transactions.
#[derive(Accounts)]
pub struct AllocateOrderBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: OrderBook PDA — being incrementally allocated.
    /// Address verified in handler against derived PDA seeds.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_allocate_order_book(
    ctx: Context<AllocateOrderBook>,
    market_key: Pubkey,
) -> Result<()> {
    let ob_info = ctx.accounts.order_book.to_account_info();

    // Derive the expected OrderBook PDA and verify address
    let (expected, bump) = Pubkey::find_program_address(
        &[StrikeMarket::ORDER_BOOK_SEED, market_key.as_ref()],
        ctx.program_id,
    );
    require!(
        ob_info.key() == expected,
        MeridianError::InvalidOrderBook
    );

    let ob_seeds: &[&[u8]] = &[
        StrikeMarket::ORDER_BOOK_SEED,
        market_key.as_ref(),
        &[bump],
    ];

    let current_len = ob_info.data_len();

    if current_len == 0 {
        // ── First call: create the PDA with up to MAX_GROWTH bytes ──────────
        let initial_space = ORDER_BOOK_TOTAL_SPACE.min(MAX_GROWTH);
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(initial_space);

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.payer.key,
                &expected,
                lamports,
                initial_space as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ob_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[ob_seeds],
        )?;

        msg!(
            "OrderBook created: {}/{} bytes",
            initial_space,
            ORDER_BOOK_TOTAL_SPACE,
        );
    } else if current_len < ORDER_BOOK_TOTAL_SPACE {
        // ── Subsequent calls: grow by up to MAX_GROWTH ──────────────────────
        let new_len = (current_len + MAX_GROWTH).min(ORDER_BOOK_TOTAL_SPACE);
        let rent = Rent::get()?;
        let required_lamports = rent.minimum_balance(new_len);
        let current_lamports = ob_info.lamports();

        if required_lamports > current_lamports {
            // Top up rent via system transfer from payer
            let diff = required_lamports - current_lamports;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ob_info.clone(),
                    },
                ),
                diff,
            )?;
        }

        ob_info.resize(new_len)?;

        msg!(
            "OrderBook grown: {}/{} bytes",
            new_len,
            ORDER_BOOK_TOTAL_SPACE,
        );
    } else {
        msg!("OrderBook already at full size: {} bytes", ORDER_BOOK_TOTAL_SPACE);
    }

    Ok(())
}
