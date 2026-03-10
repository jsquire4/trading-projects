use anchor_lang::prelude::*;
use crate::error::OracleError;
use crate::state::PriceFeed;

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ OracleError::InvalidAuthority,
        constraint = price_feed.is_initialized @ OracleError::FeedNotInitialized,
    )]
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handle_update_price(ctx: Context<UpdatePrice>, price: u64, confidence: u64, timestamp: i64) -> Result<()> {
    require!(price > 0, OracleError::InvalidPrice);
    require!(timestamp > 0, OracleError::InvalidTimestamp);

    let feed = &mut ctx.accounts.price_feed;
    feed.price = price;
    feed.confidence = confidence;
    feed.timestamp = timestamp;

    msg!(
        "Oracle updated: ticker={}, price={}, confidence={}, ts={}",
        std::str::from_utf8(&feed.ticker)
            .unwrap_or("???")
            .trim_end_matches('\0'),
        price,
        confidence,
        timestamp
    );

    Ok(())
}
