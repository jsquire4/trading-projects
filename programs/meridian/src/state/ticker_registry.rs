use anchor_lang::prelude::*;

/// A single entry in the TickerRegistry.
/// 48 bytes per entry (8 ticker + 1 is_active + 32 pyth_feed + 7 padding).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub struct TickerEntry {
    /// Ticker symbol, null-padded to 8 bytes (e.g., b"AAPL\0\0\0\0")
    pub ticker: [u8; 8],
    /// Whether this ticker is active (admin can deactivate for moderation)
    pub is_active: bool,
    /// Pyth price feed account address (Pubkey::default() when oracle_type == Mock)
    pub pyth_feed: Pubkey,
    /// Reserved padding for alignment
    pub _padding: [u8; 7],
}

impl TickerEntry {
    pub const LEN: usize = 8 + 1 + 32 + 7; // 48 bytes
}

/// Dynamic ticker registry PDA. Grows via realloc as tickers are added.
///
/// Account layout:
///   8 (discriminator) + 1 (bump) + 7 (padding) + N * 48 (entries)
///
/// Seeds: ["tickers"]
#[account]
pub struct TickerRegistry {
    /// PDA bump
    pub bump: u8,
    /// Reserved padding
    pub _padding: [u8; 7],
    /// Dynamic list of ticker entries
    pub entries: Vec<TickerEntry>,
}

impl TickerRegistry {
    pub const SEED_PREFIX: &'static [u8] = b"tickers";

    /// Base size: discriminator(8) + bump(1) + padding(7) + vec length prefix(4)
    pub const BASE_LEN: usize = 8 + 1 + 7 + 4;

    /// Size for N entries
    pub fn size_for(n: usize) -> usize {
        Self::BASE_LEN + n * TickerEntry::LEN
    }

    /// Check if a ticker exists and is active
    pub fn is_active_ticker(&self, ticker: &[u8; 8]) -> bool {
        self.entries
            .iter()
            .any(|e| &e.ticker == ticker && e.is_active)
    }

    /// Check if a ticker exists (active or not)
    pub fn has_ticker(&self, ticker: &[u8; 8]) -> bool {
        self.entries.iter().any(|e| &e.ticker == ticker)
    }

    /// Find the index of a ticker entry
    pub fn find_index(&self, ticker: &[u8; 8]) -> Option<usize> {
        self.entries.iter().position(|e| &e.ticker == ticker)
    }
}
