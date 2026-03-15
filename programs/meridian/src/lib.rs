use anchor_lang::prelude::*;

#[macro_use]
pub mod helpers;
pub mod error;
pub mod matching;
pub mod state;

pub mod instructions;

// Re-export all instruction Accounts structs and their generated __client_accounts_*
// modules at crate root — required by the Anchor #[program] macro.
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
pub use instructions::update_fee_bps::*;
pub use instructions::update_strike_creation_fee::*;
pub use instructions::crank_redeem::*;
// Phase 6A: Admin V2
pub use instructions::transfer_admin::*;
pub use instructions::accept_admin::*;
pub use instructions::withdraw_fees::*;
pub use instructions::withdraw_treasury::*;
pub use instructions::update_config::*;
pub use instructions::add_ticker::*;
pub use instructions::deactivate_ticker::*;
pub use instructions::circuit_breaker::*;
pub use instructions::initialize_ticker_registry::*;

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

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handle_unpause(ctx)
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

    pub fn update_fee_bps(ctx: Context<UpdateFeeBps>, new_fee_bps: u16) -> Result<()> {
        instructions::update_fee_bps::handle_update_fee_bps(ctx, new_fee_bps)
    }

    pub fn update_strike_creation_fee(
        ctx: Context<UpdateStrikeCreationFee>,
        new_fee: u64,
    ) -> Result<()> {
        instructions::update_strike_creation_fee::handle_update_strike_creation_fee(ctx, new_fee)
    }

    pub fn crank_redeem<'info>(
        ctx: Context<'_, '_, '_, 'info, CrankRedeem<'info>>,
        batch_size: u8,
    ) -> Result<()> {
        instructions::crank_redeem::handle_crank_redeem(ctx, batch_size)
    }

    // ── Phase 6A: Admin V2 ───────────────────────────────────────────

    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::transfer_admin::handle_transfer_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handle_accept_admin(ctx)
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        instructions::withdraw_fees::handle_withdraw_fees(ctx)
    }

    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        instructions::withdraw_treasury::handle_withdraw_treasury(ctx, amount)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        staleness_threshold: Option<u64>,
        settlement_staleness: Option<u64>,
        confidence_bps: Option<u64>,
        operating_reserve: Option<u64>,
        settlement_blackout_minutes: Option<u16>,
        slot_rent_markup: Option<u64>,
    ) -> Result<()> {
        instructions::update_config::handle_update_config(
            ctx,
            staleness_threshold,
            settlement_staleness,
            confidence_bps,
            operating_reserve,
            settlement_blackout_minutes,
            slot_rent_markup,
        )
    }

    pub fn add_ticker<'info>(
        ctx: Context<'_, '_, '_, 'info, AddTicker<'info>>,
        ticker: [u8; 8],
    ) -> Result<()> {
        instructions::add_ticker::handle_add_ticker(ctx, ticker)
    }

    pub fn deactivate_ticker(ctx: Context<DeactivateTicker>, ticker: [u8; 8]) -> Result<()> {
        instructions::deactivate_ticker::handle_deactivate_ticker(ctx, ticker)
    }

    pub fn circuit_breaker(ctx: Context<CircuitBreaker>) -> Result<()> {
        instructions::circuit_breaker::handle_circuit_breaker(ctx)
    }

    pub fn initialize_ticker_registry(ctx: Context<InitializeTickerRegistry>) -> Result<()> {
        instructions::initialize_ticker_registry::handle_initialize_ticker_registry(ctx)
    }
}
