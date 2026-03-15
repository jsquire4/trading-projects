mod validate;
mod escrow;
mod fill_processor;
mod stats;

use validate::{validate_order_params, validate_market_time};
use escrow::{escrow_taker_assets, refund_unfilled};
use fill_processor::{process_fills, FillContext};
use stats::update_market_stats;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::{match_against_book, place_resting_order, MatchResult, PlaceError};
use crate::state::order_book::*;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
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
        has_one = escrow_vault @ MeridianError::InvalidEscrow,
        has_one = yes_escrow @ MeridianError::InvalidEscrow,
        has_one = no_escrow @ MeridianError::InvalidEscrow,
        has_one = order_book @ MeridianError::InvalidOrderBook,
        constraint = !market.is_settled @ MeridianError::MarketAlreadySettled,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Sparse order book PDA — validated via market.order_book and discriminator.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

    /// USDC collateral vault (for merge/burn debits)
    #[account(mut)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// USDC escrow for bid orders
    #[account(mut)]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Yes token escrow for ask orders
    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// No token escrow for No-backed bid orders
    #[account(mut)]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's USDC ATA (escrow source for side=0, payout dest for merge/burn)
    #[account(
        mut,
        constraint = user_usdc_ata.mint == config.usdc_mint @ MeridianError::InvalidMint,
        constraint = user_usdc_ata.owner == user.key() @ MeridianError::SignerMismatch,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA (escrow source for side=1, receipt for swap fills)
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's No ATA (escrow source for side=2, position constraint for side=0)
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    /// Fee vault — collects protocol fees from fills
    #[account(
        mut,
        seeds = [GlobalConfig::FEE_VAULT_SEED],
        bump,
        constraint = fee_vault.mint == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: maker USDC/Yes ATAs passed dynamically per fill
}

pub fn handle_place_order<'info>(
    ctx: Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
    side: u8,
    price: u8,
    quantity: u64,
    order_type: u8,
    max_fills: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    validate_order_params(side, price, quantity, order_type)?;
    validate_market_time(&ctx, &clock)?;

    // Validate order book
    let ob_info = ctx.accounts.order_book.to_account_info();
    require!(
        ob_info.owner == ctx.program_id,
        MeridianError::InvalidOrderBook
    );

    // Position constraints with reload()
    if side == SIDE_USDC_BID {
        ctx.accounts.user_no_ata.reload()?;
        require!(
            ctx.accounts.user_no_ata.amount == 0,
            MeridianError::ConflictingPosition
        );
    }
    if side == SIDE_NO_BID {
        ctx.accounts.user_yes_ata.reload()?;
        require!(
            ctx.accounts.user_yes_ata.amount == 0,
            MeridianError::ConflictingPosition
        );
    }

    // --- Build signer seeds ---
    let market = &ctx.accounts.market;
    let market_key = market.key();
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    // --- Escrow the taker's assets ---
    escrow_taker_assets(&ctx, side, price, quantity)?;

    // --- Run matching engine ---
    let match_result;
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        require!(
            verify_discriminator(&ob_data),
            MeridianError::OrderBookDiscriminatorMismatch
        );
        require!(
            book_market(&ob_data) == market_key,
            MeridianError::InvalidMarket
        );
        match_result = match_against_book(
            &mut ob_data,
            side,
            price,
            quantity,
            max_fills,
        );
    }

    // --- Process fills and compute price improvement refund ---
    let tp = ctx.accounts.token_program.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();
    let escrow_ai = ctx.accounts.escrow_vault.to_account_info();
    let yes_escrow_ai = ctx.accounts.yes_escrow.to_account_info();
    let no_escrow_ai = ctx.accounts.no_escrow.to_account_info();
    let vault_ai = ctx.accounts.usdc_vault.to_account_info();
    let yes_mint_ai = ctx.accounts.yes_mint.to_account_info();
    let no_mint_ai = ctx.accounts.no_mint.to_account_info();
    let user_usdc_ai = ctx.accounts.user_usdc_ata.to_account_info();
    let user_yes_ai = ctx.accounts.user_yes_ata.to_account_info();
    let fee_vault_ai = ctx.accounts.fee_vault.to_account_info();
    let fee_bps = ctx.accounts.config.fee_bps;

    let fctx = FillContext {
        tp: &tp,
        market_ai: &market_ai,
        escrow_ai: &escrow_ai,
        yes_escrow_ai: &yes_escrow_ai,
        no_escrow_ai: &no_escrow_ai,
        vault_ai: &vault_ai,
        yes_mint_ai: &yes_mint_ai,
        no_mint_ai: &no_mint_ai,
        user_usdc_ai: &user_usdc_ai,
        user_yes_ai: &user_yes_ai,
        fee_vault_ai: &fee_vault_ai,
        remaining_accounts: ctx.remaining_accounts,
        fee_bps,
        signer_seeds,
    };

    let price_improvement_refund = process_fills(
        &match_result,
        side,
        price,
        market_key,
        ctx.accounts.user.key(),
        clock.unix_timestamp,
        &fctx,
    )?;

    // --- Price improvement refund ---
    if price_improvement_refund > 0 {
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
            price_improvement_refund,
        )?;
    }

    // --- Place resting order (limit orders with remaining qty) ---
    let mut resting_failed = false;
    if order_type == ORDER_TYPE_LIMIT && match_result.remaining_quantity >= MIN_ORDER_SIZE {
        // May need to allocate a new level via realloc
        let place_result = try_place_resting_order(
            &ob_info,
            &ctx.accounts.user,
            &ctx.accounts.system_program,
            &ctx.accounts.market,
            side,
            price,
            match_result.remaining_quantity,
            quantity,
            clock.unix_timestamp,
        )?;
        resting_failed = !place_result;
    }

    // --- Handle resting order failure: refund remaining quantity ---
    if resting_failed && match_result.remaining_quantity > 0 {
        msg!(
            "Resting order failed (level full): refunding {} remaining to user={}",
            match_result.remaining_quantity,
            ctx.accounts.user.key(),
        );
        let failed_refund_result = MatchResult {
            fills: Vec::new(),
            remaining_quantity: match_result.remaining_quantity,
            resting_failed: false,
        };
        refund_unfilled(
            &failed_refund_result,
            side,
            price,
            ORDER_TYPE_MARKET,
            &ctx,
            &tp,
            &market_ai,
            &escrow_ai,
            &yes_escrow_ai,
            &no_escrow_ai,
            signer_seeds,
        )?;
    }

    // --- Refund unfilled escrow ---
    if !resting_failed {
        refund_unfilled(
            &match_result,
            side,
            price,
            order_type,
            &ctx,
            &tp,
            &market_ai,
            &escrow_ai,
            &yes_escrow_ai,
            &no_escrow_ai,
            signer_seeds,
        )?;
    }

    // --- Update market stats (after all signer_seeds usage, avoids clone) ---
    update_market_stats(&mut ctx.accounts.market, &match_result, order_type)?;

    let unfilled = match_result.remaining_quantity;
    let was_rested = order_type == ORDER_TYPE_LIMIT && unfilled >= MIN_ORDER_SIZE && !resting_failed;
    let total_filled: u64 = match_result
        .fills
        .iter()
        .map(|f| f.quantity)
        .try_fold(0u64, |acc, q| acc.checked_add(q))
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "Order placed: user={}, market={}, side={}, price={}, qty={}, filled={}, rested={}",
        ctx.accounts.user.key(),
        market_key,
        side,
        price,
        quantity,
        total_filled,
        was_rested,
    );

    Ok(())
}

/// Try to place a resting order, allocating a new level via realloc if needed.
/// Returns Ok(true) if placed successfully, Ok(false) if level is full.
fn try_place_resting_order<'info>(
    ob_info: &AccountInfo<'info>,
    user: &Signer<'info>,
    system_program: &Program<'info, System>,
    market: &Account<'info, StrikeMarket>,
    side: u8,
    price: u8,
    quantity: u64,
    original_quantity: u64,
    timestamp: i64,
) -> Result<bool> {
    // First attempt: try placing directly
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        match place_resting_order(
            &mut ob_data,
            &user.key(),
            side,
            price,
            quantity,
            original_quantity,
            timestamp,
            &user.key(),
        ) {
            Ok(_order_id) => return Ok(true),
            Err(PlaceError::LevelFull) => return Ok(false),
            Err(PlaceError::OrderIdOverflow) => return Ok(false),
            Err(PlaceError::NeedsNewLevel) => {
                // Fall through to allocate
            }
        }
    }

    // Need to allocate a new level — realloc the account
    allocate_new_level(ob_info, user, system_program, market)?;

    // Initialize the new level
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        let _level_idx = ob_data[HDR_LEVEL_COUNT]; // will be incremented by init_level
        let max_levels = ob_data[HDR_MAX_LEVELS];
        // Find a free slot in the allocated levels
        let free_idx = find_free_level_slot(&ob_data)
            .unwrap_or(max_levels.saturating_sub(1));
        init_level(&mut ob_data, free_idx, price);
    }

    // Retry placement
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        match place_resting_order(
            &mut ob_data,
            &user.key(),
            side,
            price,
            quantity,
            original_quantity,
            timestamp,
            &user.key(),
        ) {
            Ok(_order_id) => Ok(true),
            Err(_) => Ok(false),
        }
    }
}

/// Allocate space for one new level in the order book via realloc.
/// Transfers rent from user to the order book account.
fn allocate_new_level<'info>(
    ob_info: &AccountInfo<'info>,
    user: &Signer<'info>,
    system_program: &Program<'info, System>,
    _market: &Account<'info, StrikeMarket>,
) -> Result<()> {
    let current_len = ob_info.data_len();
    let orders_per_level;
    let new_max_levels;

    {
        let ob_data = ob_info.try_borrow_data()?;
        orders_per_level = ob_data[HDR_ORDERS_PER_LEVEL];
        let max_levels = ob_data[HDR_MAX_LEVELS];

        require!(
            (max_levels as usize) < MAX_PRICE_LEVELS,
            MeridianError::MaxLevelsReached
        );
        new_max_levels = max_levels + 1;
    }

    let entry_size = LEVEL_HEADER_SIZE + orders_per_level as usize * ORDER_SLOT_SIZE;
    let new_len = current_len + entry_size;

    // Transfer rent for the new space
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(new_len);
    let current_lamports = ob_info.lamports();

    if required_lamports > current_lamports {
        let diff = required_lamports - current_lamports;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: user.to_account_info(),
                    to: ob_info.clone(),
                },
            ),
            diff,
        )?;
    }

    // Realloc
    ob_info.realloc(new_len, false)?;

    // Update max_levels in header
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        ob_data[HDR_MAX_LEVELS] = new_max_levels;
    }

    Ok(())
}
