mod validate;
mod escrow;
mod fill_processor;
mod stats;

use validate::{validate_order_params, validate_market_time};
use escrow::{escrow_taker_assets, refund_unfilled};
use fill_processor::process_fills;
use stats::update_market_stats;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::{match_order, MatchResult};
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
        constraint = !market.is_paused @ MeridianError::MarketPaused,
        constraint = !market.is_closed @ MeridianError::MarketClosed,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        constraint = order_book.load()?.market == market.key() @ MeridianError::InvalidMarket,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

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

    // Position constraints with reload() to get fresh balances in composable txs.
    // Note: No constraint for SIDE_YES_ASK (Sell Yes). Selling Yes must work while
    // holding No tokens — this is part of the atomic "Buy No" flow (mint pair → sell Yes).
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
    let mut ob = ctx.accounts.order_book.load_mut()?;
    let match_result = match_order(
        &mut ob,
        ctx.accounts.user.key(),
        side,
        price,
        quantity,
        order_type,
        max_fills,
        clock.unix_timestamp,
    );
    drop(ob); // Release borrow before token operations

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

    let price_improvement_refund = process_fills(
        &match_result,
        side,
        price,
        market_key,
        ctx.accounts.user.key(),
        clock.unix_timestamp,
        ctx.remaining_accounts,
        &tp,
        &market_ai,
        &escrow_ai,
        &yes_escrow_ai,
        &no_escrow_ai,
        &vault_ai,
        &yes_mint_ai,
        &no_mint_ai,
        &user_usdc_ai,
        &user_yes_ai,
        &fee_vault_ai,
        fee_bps,
        signer_seeds,
    )?;

    // --- Price improvement refund (USDC bids filled at better price) ---
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

    // --- Handle resting order failure: refund remaining quantity ---
    // Note: For USDC bids, the refund uses floor division (quantity * price / 100),
    // which may leave up to (price-1) lamports in escrow due to rounding. This is
    // acceptable because the ceiling-division escrow ensures the protocol never
    // under-collateralizes, and the dust amount is negligible (<1 cent).
    if match_result.resting_failed && match_result.remaining_quantity > 0 {
        msg!(
            "Resting order failed (level full): refunding {} remaining to user={}",
            match_result.remaining_quantity,
            ctx.accounts.user.key(),
        );
        // Force refund as if it were a market order (treat remaining as unfilled)
        let failed_refund_result = MatchResult {
            fills: Vec::new(),
            remaining_quantity: match_result.remaining_quantity,
            resting_failed: false,
        };
        refund_unfilled(
            &failed_refund_result,
            side,
            price,
            ORDER_TYPE_MARKET, // treat as market order to force refund
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
    if !match_result.resting_failed {
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

    // --- Update market stats and validate fill requirements ---
    update_market_stats(&mut ctx.accounts.market, &match_result, order_type)?;

    let unfilled = match_result.remaining_quantity;
    let was_rested = order_type == ORDER_TYPE_LIMIT && unfilled >= MIN_ORDER_SIZE;
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
