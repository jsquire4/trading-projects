use anchor_lang::prelude::*;

#[account]
pub struct StrikeMarket {
    // — 32-byte aligned (Pubkeys) —
    /// Parent GlobalConfig
    pub config: Pubkey,
    /// Yes token mint
    pub yes_mint: Pubkey,
    /// No token mint
    pub no_mint: Pubkey,
    /// USDC collateral vault (holds $1 × pairs minted)
    pub usdc_vault: Pubkey,
    /// USDC escrow for bid orders (side=0)
    pub escrow_vault: Pubkey,
    /// Yes token escrow for ask orders (side=1)
    pub yes_escrow: Pubkey,
    /// No token escrow for No-backed bid orders (side=2)
    pub no_escrow: Pubkey,
    /// OrderBook account
    pub order_book: Pubkey,
    /// PriceFeed oracle account
    pub oracle_feed: Pubkey,

    // — 8-byte aligned (u64/i64) —
    /// Strike price in USDC lamports (e.g., 680_000_000 = $680.00)
    pub strike_price: u64,
    /// UTC timestamp for 4 PM ET on this trading day
    pub market_close_unix: i64,
    /// Total pairs minted (in token lamports)
    pub total_minted: u64,
    /// Total pairs redeemed
    pub total_redeemed: u64,
    /// Oracle price at settlement (0 if unsettled)
    pub settlement_price: u64,
    /// Reference price for display (previous close)
    pub previous_close: u64,
    /// Settlement timestamp (0 if unsettled)
    pub settled_at: i64,
    /// settled_at + 3600; admin can override until this time. 0 if unsettled.
    pub override_deadline: i64,

    // — 32-byte aligned (continued) —
    /// Address Lookup Table for this market (set post-creation via set_market_alt)
    pub alt_address: Pubkey,

    // — 1-byte aligned —
    /// Stock ticker (UTF-8, zero-padded)
    pub ticker: [u8; 8],
    /// Whether market has been settled
    pub is_settled: bool,
    /// 0=unsettled, 1=YesWins, 2=NoWins
    pub outcome: u8,
    /// Number of overrides used (max 3)
    pub override_count: u8,
    /// PDA bump
    pub bump: u8,
    /// Alignment padding
    pub _padding: [u8; 4],
}

impl StrikeMarket {
    pub const SEED_PREFIX: &'static [u8] = b"market";
    pub const YES_MINT_SEED: &'static [u8] = b"yes_mint";
    pub const NO_MINT_SEED: &'static [u8] = b"no_mint";
    pub const VAULT_SEED: &'static [u8] = b"vault";
    pub const ESCROW_SEED: &'static [u8] = b"escrow";
    pub const YES_ESCROW_SEED: &'static [u8] = b"yes_escrow";
    pub const NO_ESCROW_SEED: &'static [u8] = b"no_escrow";
    pub const ORDER_BOOK_SEED: &'static [u8] = b"order_book";

    // Field sum: 10×32 + 8×8 + 8 + 4×1 + 4 = 320 + 64 + 8 + 4 + 4 = 400 bytes
    // is_paused and is_closed removed; padding absorbs the freed bytes
    pub const LEN: usize = (10 * 32) + (8 * 8) + 8 + 4 + 4; // 400 bytes
}
