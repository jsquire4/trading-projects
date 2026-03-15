use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, CloseAccount};
use crate::error::MeridianError;
use crate::matching::engine::has_active_orders;
use crate::state::order_book::verify_discriminator;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
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

    /// CHECK: Sparse order book PDA — validated via market.order_book.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

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

    /// Treasury USDC account — receives escrow dust
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

    // Gate: order book must be empty
    {
        let ob_info = ctx.accounts.order_book.to_account_info();
        require!(
            ob_info.owner == ctx.program_id,
            MeridianError::InvalidOrderBook
        );
        let ob_data = ob_info.try_borrow_data()?;
        require!(
            verify_discriminator(&ob_data),
            MeridianError::OrderBookDiscriminatorMismatch
        );
        require!(
            !has_active_orders(&ob_data),
            MeridianError::CloseMarketOrderBookNotEmpty,
        );
    }

    // Gate: all tokens must be redeemed (no partial close)
    let yes_supply = ctx.accounts.yes_mint.supply;
    let no_supply = ctx.accounts.no_mint.supply;
    require!(
        yes_supply == 0 && no_supply == 0,
        MeridianError::MintSupplyNotZero,
    );

    // Build signer seeds
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    // Sweep escrow dust to treasury
    let escrow_dust = ctx.accounts.escrow_vault.amount;
    if escrow_dust > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            escrow_dust,
        )?;
    }

    // Close token accounts (rent lamports go to admin for now — GROUP 4 redirects to SOL Treasury)
    let accounts_to_close: Vec<(AccountInfo<'_>, AccountInfo<'_>)> = vec![
        (ctx.accounts.usdc_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
        (ctx.accounts.escrow_vault.to_account_info(), ctx.accounts.admin.to_account_info()),
        (ctx.accounts.yes_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
        (ctx.accounts.no_escrow.to_account_info(), ctx.accounts.admin.to_account_info()),
    ];

    for (account, destination) in accounts_to_close {
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

    // Drain OrderBook lamports (to admin for now — GROUP 4 redirects to SOL Treasury)
    drain_lamports(&ctx.accounts.order_book.to_account_info(), &ctx.accounts.admin.to_account_info())?;

    // Drain StrikeMarket lamports
    drain_lamports(&ctx.accounts.market.to_account_info(), &ctx.accounts.admin.to_account_info())?;

    msg!(
        "Market closed: market={}, 6 accounts closed (mints remain with 0 supply)",
        ctx.accounts.market.key(),
    );

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

    let mut data = source.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }

    Ok(())
}
