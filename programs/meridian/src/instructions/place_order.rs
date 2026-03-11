use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::MeridianError;
use crate::matching::engine::{match_order, Fill, MatchResult};
use crate::state::events::FillEvent;
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
    validate_order(&ctx, side, price, quantity, order_type, &clock)?;

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

    // --- Refund unfilled escrow ---
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

/// Validates order parameters, market time constraints, and position constraints.
fn validate_order(
    ctx: &Context<'_, '_, '_, '_, PlaceOrder<'_>>,
    side: u8,
    price: u8,
    quantity: u64,
    order_type: u8,
    clock: &Clock,
) -> Result<()> {
    require!(
        side == SIDE_USDC_BID || side == SIDE_YES_ASK || side == SIDE_NO_BID,
        MeridianError::InvalidSide
    );
    require!(price >= 1 && price <= 99, MeridianError::InvalidPrice);
    require!(quantity >= MIN_ORDER_SIZE, MeridianError::InvalidQuantity);
    require!(
        order_type == ORDER_TYPE_MARKET || order_type == ORDER_TYPE_LIMIT,
        MeridianError::InvalidOrderType
    );

    // Reject orders after market close
    require!(
        clock.unix_timestamp < ctx.accounts.market.market_close_unix,
        MeridianError::MarketClosed
    );

    // Position constraint: side=0 (Buy Yes) requires No balance == 0
    if side == SIDE_USDC_BID {
        require!(
            ctx.accounts.user_no_ata.amount == 0,
            MeridianError::ConflictingPosition
        );
    }

    Ok(())
}

/// Transfers the taker's assets into the appropriate escrow account based on side.
fn escrow_taker_assets(
    ctx: &Context<'_, '_, '_, '_, PlaceOrder<'_>>,
    side: u8,
    price: u8,
    quantity: u64,
) -> Result<()> {
    match side {
        SIDE_USDC_BID => {
            // Escrow USDC: cost = quantity * price / 100
            let escrow_amount = quantity
                .checked_mul(price as u64)
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

/// Processes all fills from the matching engine, executing token transfers/burns
/// and emitting FillEvents. Returns the accumulated price improvement refund amount.
#[allow(clippy::too_many_arguments)]
fn process_fills<'info>(
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
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    let mut rem_idx: usize = 0;
    let mut price_improvement_refund: u64 = 0;

    for fill in &match_result.fills {
        if fill.is_merge {
            process_merge_fill(
                fill,
                side,
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
                signer_seeds,
            )?;
        } else {
            let improvement = process_swap_fill(
                fill,
                side,
                price,
                remaining_accounts,
                &mut rem_idx,
                tp,
                market_ai,
                escrow_ai,
                yes_escrow_ai,
                user_usdc_ai,
                user_yes_ai,
                signer_seeds,
            )?;
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
        });
    }

    Ok(price_improvement_refund)
}

/// Processes a single merge/burn fill: burns Yes and No tokens from escrow,
/// then distributes USDC payouts to taker and maker.
#[allow(clippy::too_many_arguments)]
fn process_merge_fill<'info>(
    fill: &Fill,
    side: u8,
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
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let yes_payout_per_unit = (fill.price as u64)
        .checked_mul(PRICE_TO_USDC_LAMPORTS)
        .ok_or(MeridianError::ArithmeticOverflow)?;
    let no_payout_per_unit = USDC_LAMPORTS_PER_DOLLAR
        .checked_sub(yes_payout_per_unit)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    let yes_payout = (fill.quantity as u128)
        .checked_mul(yes_payout_per_unit as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;
    let no_payout = (fill.quantity as u128)
        .checked_mul(no_payout_per_unit as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;

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
        // fill.price = No bid price (P). Yes seller gets (100-P), No seller gets P.
        // Taker = Yes seller -> gets no_payout (= 100-P) from vault
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

        // Maker = No seller -> gets yes_payout (= P)
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_usdc = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
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

    Ok(())
}

/// Processes a single standard swap fill. Returns the price improvement amount
/// (non-zero only for USDC bid fills at a better price than the taker's limit).
#[allow(clippy::too_many_arguments)]
fn process_swap_fill<'info>(
    fill: &Fill,
    side: u8,
    price: u8,
    remaining_accounts: &[AccountInfo<'info>],
    rem_idx: &mut usize,
    tp: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    escrow_ai: &AccountInfo<'info>,
    yes_escrow_ai: &AccountInfo<'info>,
    user_usdc_ai: &AccountInfo<'info>,
    user_yes_ai: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    let fill_usdc = (fill.quantity as u128)
        .checked_mul(fill.price as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_mul(PRICE_TO_USDC_LAMPORTS as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(USDC_LAMPORTS_PER_DOLLAR as u128)
        .ok_or(MeridianError::DivisionByZero)? as u64;

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

        // USDC from escrow_vault -> maker
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_usdc = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
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
            fill_usdc,
        )?;

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
        // USDC from escrow -> taker
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
            fill_usdc,
        )?;

        // Yes from yes_escrow -> maker
        require!(
            *rem_idx < remaining_accounts.len(),
            MeridianError::InsufficientAccounts
        );
        let maker_yes = &remaining_accounts[*rem_idx];
        *rem_idx += 1;
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

    Ok(improvement)
}

/// Refunds unfilled escrow amounts back to the taker for market orders
/// and limit orders with dust remainders (below MIN_ORDER_SIZE).
#[allow(clippy::too_many_arguments)]
fn refund_unfilled<'info>(
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
            let refund = unfilled
                .checked_mul(price as u64)
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

/// Updates market statistics after fill processing. Accumulates merge/burn quantities
/// into total_redeemed and enforces that market orders must fill at least partially.
fn update_market_stats(
    market: &mut Account<'_, StrikeMarket>,
    match_result: &MatchResult,
    order_type: u8,
) -> Result<()> {
    let total_merged: u64 = match_result
        .fills
        .iter()
        .filter(|f| f.is_merge)
        .map(|f| f.quantity)
        .try_fold(0u64, |acc, q| acc.checked_add(q))
        .ok_or(MeridianError::ArithmeticOverflow)?;

    if total_merged > 0 {
        market.total_redeemed = market
            .total_redeemed
            .checked_add(total_merged)
            .ok_or(MeridianError::ArithmeticOverflow)?;
    }

    let total_filled: u64 = match_result
        .fills
        .iter()
        .map(|f| f.quantity)
        .try_fold(0u64, |acc, q| acc.checked_add(q))
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Market orders must fill at least partially
    require!(
        total_filled > 0 || order_type == ORDER_TYPE_LIMIT,
        MeridianError::NoFillsAvailable
    );

    Ok(())
}
