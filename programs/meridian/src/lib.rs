use anchor_lang::prelude::*;

pub mod error;
pub mod matching;
pub mod state;

pub mod instructions;

// Re-export all instruction Accounts structs and their generated __client_accounts_*
// modules at crate root — required by the Anchor #[program] macro.
pub use instructions::allocate_order_book::*;
pub use instructions::initialize_config::*;
pub use instructions::create_strike_market::*;
pub use instructions::set_market_alt::*;
pub use instructions::mint_pair::*;

declare_id!("7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth");

#[program]
pub mod meridian {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        tickers: [[u8; 8]; 7],
        ticker_count: u8,
        staleness_threshold: u64,
        settlement_staleness: u64,
        confidence_bps: u64,
        oracle_type: u8,
    ) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(
            ctx,
            tickers,
            ticker_count,
            staleness_threshold,
            settlement_staleness,
            confidence_bps,
            oracle_type,
        )
    }

    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        ticker: [u8; 8],
        strike_price: u64,
        expiry_day: u32,
        market_close_unix: i64,
        previous_close: u64,
    ) -> Result<()> {
        instructions::create_strike_market::handle_create_strike_market(
            ctx,
            ticker,
            strike_price,
            expiry_day,
            market_close_unix,
            previous_close,
        )
    }

    pub fn set_market_alt(ctx: Context<SetMarketAlt>, alt_address: Pubkey) -> Result<()> {
        instructions::set_market_alt::handle_set_market_alt(ctx, alt_address)
    }

    pub fn mint_pair(ctx: Context<MintPair>, quantity: u64) -> Result<()> {
        instructions::mint_pair::handle_mint_pair(ctx, quantity)
    }

    pub fn allocate_order_book(ctx: Context<AllocateOrderBook>, market_key: Pubkey) -> Result<()> {
        instructions::allocate_order_book::handle_allocate_order_book(ctx, market_key)
    }
}
