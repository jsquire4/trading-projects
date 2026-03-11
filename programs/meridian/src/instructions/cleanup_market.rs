use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct CleanupMarket<'info> {
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
        constraint = market.is_settled @ MeridianError::CloseMarketNotSettled,
        constraint = market.is_closed @ MeridianError::MarketNotClosed,
        close = admin,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    /// Yes mint — checked for zero supply but NOT closed (owned by Token program)
    pub yes_mint: Box<Account<'info, Mint>>,

    /// No mint — checked for zero supply but NOT closed (owned by Token program)
    pub no_mint: Box<Account<'info, Mint>>,
}

pub fn handle_cleanup_market(ctx: Context<CleanupMarket>) -> Result<()> {
    let yes_supply = ctx.accounts.yes_mint.supply;
    let no_supply = ctx.accounts.no_mint.supply;

    require!(
        yes_supply == 0 && no_supply == 0,
        MeridianError::MintSupplyNotZero,
    );

    // StrikeMarket is closed via Anchor's `close = admin` attribute above.
    // Mints remain on-chain (owned by Token program, cannot be closed via SPL Token v1).
    // They have 0 supply and revoked authority, so they are inert.

    msg!(
        "Market cleaned up: market={}, StrikeMarket account closed",
        ctx.accounts.market.key(),
    );

    Ok(())
}
