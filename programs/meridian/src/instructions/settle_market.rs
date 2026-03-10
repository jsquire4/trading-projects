use anchor_lang::prelude::*;
use crate::error::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(mut)]
    pub caller: Signer<'info>, // anyone can call

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = oracle_feed @ MeridianError::OracleProgramMismatch,
        constraint = !market.is_settled @ MeridianError::MarketAlreadySettled,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Oracle price feed — validated to be owned by the configured oracle program
    #[account(
        constraint = oracle_feed.owner == &config.oracle_program @ MeridianError::OracleProgramMismatch,
    )]
    pub oracle_feed: UncheckedAccount<'info>,
}

/// Manually parsed PriceFeed from mock_oracle program.
/// Layout after 8-byte Anchor discriminator:
///   ticker:         [u8; 8]
///   price:          u64
///   confidence:     u64
///   timestamp:      i64
///   authority:      Pubkey
///   is_initialized: bool
///   bump:           u8
///   _padding:       [u8; 6]
struct OraclePriceFeed {
    #[allow(dead_code)]
    pub ticker: [u8; 8],
    pub price: u64,
    pub confidence: u64,
    pub timestamp: i64,
    #[allow(dead_code)]
    pub authority: Pubkey,
    pub is_initialized: bool,
}

impl OraclePriceFeed {
    /// Minimum account data length: 8 (discriminator) + 8 + 8 + 8 + 8 + 32 + 1 + 1 + 6 = 80
    const MIN_DATA_LEN: usize = 8 + 8 + 8 + 8 + 8 + 32 + 1 + 1 + 6;

    fn parse(data: &[u8]) -> Result<Self> {
        require!(data.len() >= Self::MIN_DATA_LEN, MeridianError::OracleNotInitialized);

        let d = &data[8..]; // skip 8-byte Anchor discriminator

        let mut ticker = [0u8; 8];
        ticker.copy_from_slice(&d[0..8]);

        let price = u64::from_le_bytes(d[8..16].try_into().unwrap());
        let confidence = u64::from_le_bytes(d[16..24].try_into().unwrap());
        let timestamp = i64::from_le_bytes(d[24..32].try_into().unwrap());

        let mut authority_bytes = [0u8; 32];
        authority_bytes.copy_from_slice(&d[32..64]);
        let authority = Pubkey::new_from_array(authority_bytes);

        let is_initialized = d[64] != 0;

        Ok(Self {
            ticker,
            price,
            confidence,
            timestamp,
            authority,
            is_initialized,
        })
    }
}

pub fn handle_settle_market(ctx: Context<SettleMarket>) -> Result<()> {
    let clock = Clock::get()?;
    let market = &ctx.accounts.market;
    let config = &ctx.accounts.config;

    // ── Gate: market must have closed ──
    require!(
        clock.unix_timestamp >= market.market_close_unix,
        MeridianError::SettlementTooEarly
    );

    // ── Parse oracle price feed ──
    let oracle_data = ctx.accounts.oracle_feed.try_borrow_data()?;
    let feed = OraclePriceFeed::parse(&oracle_data)?;

    // ── Oracle validation ──
    require!(feed.is_initialized, MeridianError::OracleNotInitialized);
    require!(feed.price > 0, MeridianError::OraclePriceInvalid);

    // Staleness: oracle timestamp must not be in the future and must be within settlement_staleness
    require!(
        feed.timestamp <= clock.unix_timestamp,
        MeridianError::OracleStale
    );
    let oracle_age = (clock.unix_timestamp - feed.timestamp) as u64;
    require!(
        oracle_age <= config.settlement_staleness,
        MeridianError::OracleStale
    );

    // Confidence: confidence <= price * confidence_bps / 10_000
    let max_confidence = (feed.price as u128)
        .checked_mul(config.confidence_bps as u128)
        .ok_or(MeridianError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(MeridianError::DivisionByZero)? as u64;
    require!(
        feed.confidence <= max_confidence,
        MeridianError::OracleConfidenceTooWide
    );

    // ── Determine outcome ──
    // closing price >= strike → Yes wins (outcome=1)
    // closing price <  strike → No wins  (outcome=2)
    let outcome: u8 = if feed.price >= market.strike_price { 1 } else { 2 };

    // ── Write settlement fields ──
    let market = &mut ctx.accounts.market;
    market.is_settled = true;
    market.outcome = outcome;
    market.settlement_price = feed.price;
    market.settled_at = clock.unix_timestamp;
    market.override_deadline = clock
        .unix_timestamp
        .checked_add(3600)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    msg!(
        "Market settled: market={}, price={}, strike={}, outcome={}, settled_at={}",
        market.key(),
        feed.price,
        market.strike_price,
        outcome,
        clock.unix_timestamp,
    );

    Ok(())
}
