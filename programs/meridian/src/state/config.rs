use anchor_lang::prelude::*;
use super::order_book::{ADMIN_SETTLE_DELAY_SECS, OVERRIDE_WINDOW_SECS};

#[account]
pub struct GlobalConfig {
    /// Admin authority
    pub admin: Pubkey,
    /// Mock USDC mint on devnet (real USDC on mainnet)
    pub usdc_mint: Pubkey,
    /// Mock oracle program ID
    pub oracle_program: Pubkey,
    /// Max oracle age for general ops (default 60s)
    pub staleness_threshold: u64,
    /// Max oracle age for settlement (default 120s)
    pub settlement_staleness: u64,
    /// Max confidence band as basis points of price (default 50 = 0.5%)
    pub confidence_bps: u64,
    /// Global pause flag
    pub is_paused: bool,
    /// Oracle type: 0=Mock, 1=Pyth
    pub oracle_type: u8,
    /// Supported tickers (7 MAG7, padded to 8 bytes each) — legacy, use TickerRegistry
    pub tickers: [[u8; 8]; 7],
    /// Number of active tickers — legacy, use TickerRegistry
    pub ticker_count: u8,
    /// PDA bump
    pub bump: u8,
    /// Protocol fee in basis points (max 1000 = 10%), applied to both sides of every fill
    pub fee_bps: u16,
    /// Alignment padding
    pub _padding: [u8; 2],
    /// Fee in USDC lamports charged to non-admin users creating strike markets
    pub strike_creation_fee: u64,

    /// Proposed new admin (two-step transfer). Pubkey::default() = no pending transfer.
    pub pending_admin: Pubkey,
    /// Admin-configurable SOL reserve for next-day market creation float
    pub operating_reserve: u64,
    /// Total USDC obligations owed to users from settled markets
    pub obligations: u64,
    /// Settlement blackout window in minutes (0 = no blackout)
    pub settlement_blackout_minutes: u16,
    /// Padding for 8-byte alignment
    pub _padding2: [u8; 6],
}

impl GlobalConfig {
    pub const SEED_PREFIX: &'static [u8] = b"config";
    pub const TREASURY_SEED: &'static [u8] = b"treasury";
    pub const FEE_VAULT_SEED: &'static [u8] = b"fee_vault";

    pub const LEN: usize = 248;

    /// Check ticker against the legacy tickers array (for backward compat)
    pub fn is_valid_ticker(&self, ticker: &[u8; 8]) -> bool {
        self.tickers[..(self.ticker_count as usize).min(self.tickers.len())]
            .iter()
            .any(|t| t == ticker)
    }

    /// Admin settle delay: 1hr for all oracle types.
    pub fn admin_settle_delay(&self) -> i64 {
        ADMIN_SETTLE_DELAY_SECS
    }

    /// Override window: 1 second for all oracle types.
    pub fn override_window(&self) -> i64 {
        OVERRIDE_WINDOW_SECS
    }
}
