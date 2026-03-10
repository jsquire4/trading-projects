use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct PriceFeed {
    /// Stock ticker (UTF-8, zero-padded to 8 bytes)
    pub ticker: [u8; 8],
    /// Current price in USDC lamports (e.g., 200_000_000 = $200.00)
    pub price: u64,
    /// Confidence band width in USDC lamports
    pub confidence: u64,
    /// Last update time (unix timestamp)
    pub timestamp: i64,
    /// Who can update this feed
    pub authority: Pubkey,
    /// Whether this feed has been initialized
    pub is_initialized: bool,
    /// PDA bump
    pub bump: u8,
    /// Alignment padding
    pub _padding: [u8; 6],
}

impl PriceFeed {
    pub const LEN: usize = 8 + 8 + 8 + 8 + 32 + 1 + 1 + 6; // 72 bytes data
    pub const SEED_PREFIX: &'static [u8] = b"price_feed";
}
