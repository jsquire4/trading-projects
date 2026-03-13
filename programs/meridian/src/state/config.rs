use anchor_lang::prelude::*;

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
    /// Supported tickers (7 MAG7, padded to 8 bytes each)
    pub tickers: [[u8; 8]; 7],
    /// Number of active tickers
    pub ticker_count: u8,
    /// PDA bump
    pub bump: u8,
    /// Protocol fee in basis points (max 1000 = 10%), applied to both sides of every fill
    pub fee_bps: u16,
    /// Alignment padding
    pub _padding: [u8; 2],
    /// Fee in USDC lamports charged to non-admin users creating strike markets
    pub strike_creation_fee: u64,
}

impl GlobalConfig {
    pub const SEED_PREFIX: &'static [u8] = b"config";
    pub const TREASURY_SEED: &'static [u8] = b"treasury";
    pub const FEE_VAULT_SEED: &'static [u8] = b"fee_vault";

    // Calculate exact size: verify with std::mem::size_of after compilation
    // 3×32 (Pubkeys) + 4×8 (u64s) + 56 (tickers) + 4×1 (bool/u8s) + 2 (fee_bps) + 2 (padding) = 192
    pub const LEN: usize = 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 56 + 1 + 1 + 2 + 2 + 8; // 192 bytes

    pub fn is_valid_ticker(&self, ticker: &[u8; 8]) -> bool {
        self.tickers[..(self.ticker_count as usize).min(self.tickers.len())]
            .iter()
            .any(|t| t == ticker)
    }
}
