use anchor_lang::prelude::*;

/// Anchor adds 6000 to all error code discriminants.
/// So InvalidAuthority = 0 produces on-chain error code 6000.
#[error_code]
pub enum OracleError {
    #[msg("Invalid authority for this price feed")]
    InvalidAuthority = 0,
    #[msg("Price feed has not been initialized")]
    FeedNotInitialized = 1,
    #[msg("Price must be greater than zero")]
    InvalidPrice = 2,
    #[msg("Timestamp must be greater than zero")]
    InvalidTimestamp = 3,
}
