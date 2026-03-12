use anchor_lang::prelude::*;

#[event]
pub struct FillEvent {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub price: u8,
    pub quantity: u64,
    /// 0=USDC bid, 1=Yes ask, 2=No-backed bid
    pub maker_side: u8,
    /// 0=USDC bid, 1=Yes ask, 2=No-backed bid
    pub taker_side: u8,
    /// True if fill was a merge/burn (No-backed bid matched Yes ask)
    pub is_merge: bool,
    pub maker_order_id: u64,
    pub timestamp: i64,
    /// Total protocol fee on this fill (both sides combined)
    pub fee: u64,
}

#[event]
pub struct SettlementEvent {
    pub market: Pubkey,
    pub ticker: [u8; 8],
    pub strike_price: u64,
    pub settlement_price: u64,
    /// 1=YesWins, 2=NoWins
    pub outcome: u8,
    pub timestamp: i64,
}

#[event]
pub struct CrankCancelEvent {
    pub market: Pubkey,
    pub cancelled_count: u32,
}
