use anchor_lang::prelude::*;

#[macro_use]
pub mod helpers;
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
pub use instructions::place_order::*;
pub use instructions::cancel_order::*;
pub use instructions::pause::*;
pub use instructions::unpause::*;
pub use instructions::settle_market::*;
pub use instructions::admin_settle::*;
pub use instructions::admin_override_settlement::*;
pub use instructions::redeem::*;
pub use instructions::crank_cancel::*;
pub use instructions::close_market::*;
pub use instructions::treasury_redeem::*;
pub use instructions::cleanup_market::*;

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

    pub fn place_order<'info>(
        ctx: Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
        side: u8,
        price: u8,
        quantity: u64,
        order_type: u8,
        max_fills: u8,
    ) -> Result<()> {
        instructions::place_order::handle_place_order(ctx, side, price, quantity, order_type, max_fills)
    }

    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        price: u8,
        order_id: u64,
    ) -> Result<()> {
        instructions::cancel_order::handle_cancel_order(ctx, price, order_id)
    }

    pub fn pause(ctx: Context<Pause>, market: Option<Pubkey>) -> Result<()> {
        instructions::pause::handle_pause(ctx, market)
    }

    pub fn unpause(ctx: Context<Unpause>, market: Option<Pubkey>) -> Result<()> {
        instructions::unpause::handle_unpause(ctx, market)
    }

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handle_settle_market(ctx)
    }

    pub fn admin_settle(ctx: Context<AdminSettle>, settlement_price: u64) -> Result<()> {
        instructions::admin_settle::handle_admin_settle(ctx, settlement_price)
    }

    pub fn admin_override_settlement(
        ctx: Context<AdminOverrideSettlement>,
        new_settlement_price: u64,
    ) -> Result<()> {
        instructions::admin_override_settlement::handle_admin_override_settlement(
            ctx,
            new_settlement_price,
        )
    }

    pub fn redeem(ctx: Context<Redeem>, mode: u8, quantity: u64) -> Result<()> {
        instructions::redeem::handle_redeem(ctx, mode, quantity)
    }

    pub fn crank_cancel<'info>(
        ctx: Context<'_, '_, '_, 'info, CrankCancel<'info>>,
        batch_size: u8,
    ) -> Result<()> {
        instructions::crank_cancel::handle_crank_cancel(ctx, batch_size)
    }

    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::close_market::handle_close_market(ctx)
    }

    pub fn treasury_redeem(ctx: Context<TreasuryRedeem>) -> Result<()> {
        instructions::treasury_redeem::handle_treasury_redeem(ctx)
    }

    pub fn cleanup_market(ctx: Context<CleanupMarket>) -> Result<()> {
        instructions::cleanup_market::handle_cleanup_market(ctx)
    }
}
