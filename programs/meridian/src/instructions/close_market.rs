use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, SetAuthority, CloseAccount, spl_token::instruction::AuthorityType};
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket, OrderBook, MAX_PRICE_LEVELS, CLOSE_GRACE_PERIOD_SECS};

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
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
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(mut)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// Treasury USDC account (config PDA authority, seeds=[b"treasury"])
    #[account(
        mut,
        seeds = [GlobalConfig::TREASURY_SEED],
        bump,
        constraint = treasury.mint == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_close_market(ctx: Context<CloseMarket>) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // Gate: must be settled
    require!(market.is_settled, MeridianError::CloseMarketNotSettled);

    // Gate: override window must have elapsed
    require!(
        clock.unix_timestamp >= market.override_deadline,
        MeridianError::CloseMarketOverrideActive,
    );

    // Gate: not already closed
    require!(!market.is_closed, MeridianError::MarketClosed);

    // Gate: order book must be empty (all levels count == 0)
    {
        let ob = ctx.accounts.order_book.load()?;
        for i in 0..MAX_PRICE_LEVELS {
            require!(
                ob.levels[i].count == 0,
                MeridianError::CloseMarketOrderBookNotEmpty,
            );
        }
    }

    // Determine if standard close (all tokens redeemed) or partial close
    let yes_supply = ctx.accounts.yes_mint.supply;
    let no_supply = ctx.accounts.no_mint.supply;
    let all_redeemed = yes_supply == 0 && no_supply == 0;

    if all_redeemed {
        // ── Standard close: all tokens redeemed, close all 8 accounts ──
        market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

        // Close token accounts (vault, escrow, yes_escrow, no_escrow)
        let token_accounts: Vec<(
            AccountInfo<'_>,
            AccountInfo<'_>,
        )> = vec![
            (ctx.accounts.usdc_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.escrow_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.yes_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.no_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
        ];

        for (account, destination) in token_accounts {
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: account.clone(),
                    destination,
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ))?;
        }

        // Close OrderBook (program-owned, drain lamports)
        drain_lamports(&ctx.accounts.order_book.to_account_info(), &ctx.accounts.admin.to_account_info())?;

        // Close StrikeMarket (program-owned, drain lamports).
        // Note: Anchor's exit() may re-serialize the struct data after drain_lamports zeros it,
        // but the account has 0 lamports so Solana GC removes it at end of transaction.
        // We intentionally skip setting is_closed since the account is being destroyed.
        drain_lamports(&ctx.accounts.market.to_account_info(), &ctx.accounts.admin.to_account_info())?;

        // Note: Mints are owned by the Token program and cannot be closed via SPL Token v1.
        // They remain on-chain with 0 supply. Rent is minimal (~0.001 SOL each).

        msg!(
            "Market standard-closed: market={}, 6 accounts closed (mints remain with 0 supply)",
            ctx.accounts.market.key(),
        );
    } else {
        // ── Partial close: tokens remain, need 90-day grace period ──
        require!(
            clock.unix_timestamp >= market.settled_at
                .checked_add(CLOSE_GRACE_PERIOD_SECS)
                .ok_or(MeridianError::ArithmeticOverflow)?,
            MeridianError::CloseMarketGracePeriodActive,
        );

        market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

        // Transfer remaining vault USDC to treasury
        let vault_balance = ctx.accounts.usdc_vault.amount;
        if vault_balance > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.usdc_vault.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                vault_balance,
            )?;
        }

        // Revoke mint authority on Yes and No mints
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.market.to_account_info(),
                    account_or_mint: ctx.accounts.yes_mint.to_account_info(),
                },
                signer_seeds,
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.market.to_account_info(),
                    account_or_mint: ctx.accounts.no_mint.to_account_info(),
                },
                signer_seeds,
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        // Close 5 accounts: OrderBook, UsdcVault, EscrowVault, YesEscrow, NoEscrow
        let closeable_token_accounts: Vec<(
            AccountInfo<'_>,
            AccountInfo<'_>,
        )> = vec![
            (ctx.accounts.usdc_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.escrow_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.yes_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
            (ctx.accounts.no_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
        ];

        for (account, destination) in closeable_token_accounts {
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: account.clone(),
                    destination,
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ))?;
        }

        // Close OrderBook (drain lamports)
        drain_lamports(&ctx.accounts.order_book.to_account_info(), &ctx.accounts.admin.to_account_info())?;

        // Set is_closed flag — keep StrikeMarket, YesMint, NoMint alive
        let market = &mut ctx.accounts.market;
        market.is_closed = true;

        msg!(
            "Market partial-closed: market={}, vault_swept={}, 5 accounts closed, 3 kept",
            market.key(),
            vault_balance,
        );
    }

    Ok(())
}

/// Drain all lamports from an account to the destination, zeroing data.
fn drain_lamports<'info>(
    source: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    let lamports = source.lamports();
    **source.try_borrow_mut_lamports()? = 0;
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(lamports)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    // Zero account data to prevent resurrection
    let mut data = source.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }

    Ok(())
}
