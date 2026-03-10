use anchor_lang::prelude::*;
use crate::state::PriceFeed;

#[derive(Accounts)]
#[instruction(ticker: [u8; 8])]
pub struct InitializeFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::LEN,
        seeds = [PriceFeed::SEED_PREFIX, ticker.as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_feed(ctx: Context<InitializeFeed>, ticker: [u8; 8]) -> Result<()> {
    let feed = &mut ctx.accounts.price_feed;
    feed.ticker = ticker;
    feed.price = 0;
    feed.confidence = 0;
    feed.timestamp = 0;
    feed.authority = ctx.accounts.authority.key();
    feed.is_initialized = true;
    feed.bump = ctx.bumps.price_feed;

    msg!(
        "Oracle feed initialized for ticker: {}",
        std::str::from_utf8(&ticker)
            .unwrap_or("???")
            .trim_end_matches('\0')
    );

    Ok(())
}
