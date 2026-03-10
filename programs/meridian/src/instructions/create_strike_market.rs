use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::error::MeridianError;
use crate::state::{GlobalConfig, OrderBook, StrikeMarket};

#[derive(Accounts)]
#[instruction(
    ticker: [u8; 8],
    strike_price: u64,
    expiry_day: u32,
    market_close_unix: i64,
    previous_close: u64,
)]
pub struct CreateStrikeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + StrikeMarket::LEN,
        seeds = [
            StrikeMarket::SEED_PREFIX,
            ticker.as_ref(),
            &strike_price.to_le_bytes(),
            &expiry_day.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [StrikeMarket::YES_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [StrikeMarket::NO_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// USDC collateral vault — holds $1 × pairs minted
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [StrikeMarket::VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// USDC escrow for bid orders (side=0)
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [StrikeMarket::ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Yes token escrow for ask orders (side=1)
    #[account(
        init,
        payer = admin,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [StrikeMarket::YES_ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// No token escrow for No-backed bid orders (side=2)
    #[account(
        init,
        payer = admin,
        token::mint = no_mint,
        token::authority = market,
        seeds = [StrikeMarket::NO_ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    /// OrderBook — ZeroCopy, pre-allocated by client due to 10KB CPI size limit.
    /// Client must create this PDA (owned by program, zeroed, correct space)
    /// before calling create_strike_market.
    #[account(
        zero,
        seeds = [StrikeMarket::ORDER_BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// CHECK: Oracle price feed — validated to be owned by the configured oracle program
    #[account(
        constraint = oracle_feed.owner == &config.oracle_program @ MeridianError::OracleProgramMismatch,
    )]
    pub oracle_feed: UncheckedAccount<'info>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_create_strike_market(
    ctx: Context<CreateStrikeMarket>,
    ticker: [u8; 8],
    strike_price: u64,
    _expiry_day: u32,
    market_close_unix: i64,
    previous_close: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;

    // Validate ticker is in the allowed list
    require!(config.is_valid_ticker(&ticker), MeridianError::InvalidTicker);
    require!(strike_price > 0, MeridianError::InvalidStrikePrice);

    // Enforce expiry_day == floor(market_close_unix / 86400) so that
    // PDA seeds are deterministically reconstructable from stored state.
    let expected_expiry_day = (market_close_unix / 86400) as u32;
    require!(
        _expiry_day == expected_expiry_day,
        MeridianError::InvalidMarketCloseTime
    );

    let clock = Clock::get()?;
    require!(
        market_close_unix > clock.unix_timestamp,
        MeridianError::InvalidMarketCloseTime
    );

    // Initialize the market
    let market = &mut ctx.accounts.market;
    market.config = config.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.usdc_vault = ctx.accounts.usdc_vault.key();
    market.escrow_vault = ctx.accounts.escrow_vault.key();
    market.yes_escrow = ctx.accounts.yes_escrow.key();
    market.no_escrow = ctx.accounts.no_escrow.key();
    market.order_book = ctx.accounts.order_book.key();
    market.oracle_feed = ctx.accounts.oracle_feed.key();
    market.strike_price = strike_price;
    market.market_close_unix = market_close_unix;
    market.total_minted = 0;
    market.total_redeemed = 0;
    market.settlement_price = 0;
    market.previous_close = previous_close;
    market.settled_at = 0;
    market.override_deadline = 0;
    market.alt_address = Pubkey::default();
    market.ticker = ticker;
    market.is_settled = false;
    market.outcome = 0;
    market.is_paused = false;
    market.is_closed = false;
    market.override_count = 0;
    market.bump = ctx.bumps.market;

    // Initialize the order book (account pre-allocated by client, `zero` constraint
    // verified it's zeroed; load_init sets the discriminator)
    let mut ob = ctx.accounts.order_book.load_init()?;
    ob.market = market.key();
    ob.next_order_id = 0;
    ob.bump = ctx.bumps.order_book;

    let ticker_str = std::str::from_utf8(&ticker)
        .unwrap_or("???")
        .trim_end_matches('\0');

    msg!(
        "Market created: ticker={}, strike={}, close_unix={}, market={}",
        ticker_str,
        strike_price,
        market_close_unix,
        market.key(),
    );

    Ok(())
}
