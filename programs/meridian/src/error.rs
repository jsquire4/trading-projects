use anchor_lang::prelude::*;

/// Anchor adds 6000 to all error code discriminants.
/// So Unauthorized = 0 produces on-chain error code 6000.
#[error_code]
pub enum MeridianError {
    // === Authorization & Access Control (on-chain: 6000-6002) ===
    #[msg("Non-admin calling admin-only instruction")]
    Unauthorized = 0,
    #[msg("Oracle update from non-authority wallet")]
    InvalidAuthority = 1,
    #[msg("Transaction signer doesn't match expected account owner")]
    SignerMismatch = 2,

    // === Initialization & Configuration (on-chain: 6010-6016) ===
    #[msg("GlobalConfig has already been initialized")]
    ConfigAlreadyInitialized = 10,
    #[msg("Oracle feed for this ticker has already been initialized")]
    OracleFeedAlreadyInitialized = 11,
    #[msg("Ticker not in GlobalConfig tickers list")]
    InvalidTicker = 12,
    #[msg("Market close time is in the past")]
    InvalidMarketCloseTime = 13,
    #[msg("Strike price cannot be zero")]
    InvalidStrikePrice = 14,
    #[msg("Staleness threshold cannot be zero")]
    InvalidStalenessThreshold = 15,
    #[msg("Confidence bps must be between 1 and 10000")]
    InvalidConfidenceThreshold = 16,

    // === Market State (on-chain: 6020-6025) ===
    #[msg("Market has already been settled")]
    MarketAlreadySettled = 20,
    #[msg("Market has not been settled")]
    MarketNotSettled = 21,
    #[msg("Global trading is paused")]
    MarketPaused = 22,
    #[msg("Target is already paused")]
    AlreadyPaused = 23,
    #[msg("Target is not paused")]
    NotPaused = 24,
    #[msg("Market has been closed")]
    MarketClosed = 25,

    // === Account Validation (on-chain: 6030-6036) ===
    #[msg("Token account mint doesn't match expected mint")]
    InvalidMint = 30,
    #[msg("Vault account doesn't match market's stored vault")]
    InvalidVault = 31,
    #[msg("Escrow account doesn't match market's stored escrow")]
    InvalidEscrow = 32,
    #[msg("Order book doesn't match market's stored order book")]
    InvalidOrderBook = 33,
    #[msg("Market PDA doesn't match order book's stored market")]
    InvalidMarket = 34,
    #[msg("Required account has not been initialized")]
    AccountNotInitialized = 35,
    #[msg("CPI target doesn't match expected program")]
    InvalidProgramId = 36,
    #[msg("Not enough remaining_accounts for fill settlement")]
    InsufficientAccounts = 37,
    #[msg("Maker token account owner does not match fill maker")]
    InvalidMakerAccount = 38,

    // === Oracle (on-chain: 6040-6044) ===
    #[msg("Oracle price is stale — exceeds staleness threshold")]
    OracleStale = 40,
    #[msg("Oracle confidence band is too wide")]
    OracleConfidenceTooWide = 41,
    #[msg("Oracle price feed has not been initialized")]
    OracleNotInitialized = 42,
    #[msg("Oracle price is zero or invalid")]
    OraclePriceInvalid = 43,
    #[msg("Oracle program ID doesn't match GlobalConfig")]
    OracleProgramMismatch = 44,
    #[msg("Oracle account discriminator does not match PriceFeed")]
    InvalidOracleDiscriminator = 45,

    // === Trading & Order Book (on-chain: 6050-6059) ===
    #[msg("Insufficient balance to cover order or mint deposit")]
    InsufficientBalance = 50,
    #[msg("All order slots at this price level are full")]
    OrderBookFull = 51,
    #[msg("Price must be between 1 and 99")]
    InvalidPrice = 52,
    #[msg("Quantity must be at least 1 token (1_000_000 lamports)")]
    InvalidQuantity = 53,
    #[msg("Order not found at specified price level and order ID")]
    OrderNotFound = 54,
    #[msg("Cannot cancel someone else's order")]
    OrderNotOwned = 55,
    #[msg("No matching orders available for market order")]
    NoFillsAvailable = 56,
    #[msg("Order type must be Market (0) or Limit (1)")]
    InvalidOrderType = 57,
    #[msg("Order side must be 0 (Buy Yes), 1 (Sell Yes), or 2 (Sell No)")]
    InvalidSide = 58,
    #[msg("Conflicting position — cannot hold both Yes and No tokens")]
    ConflictingPosition = 59,

    // === Balance & Token Operations (on-chain: 6060-6066) ===
    #[msg("Vault balance doesn't match (total_minted - total_redeemed) — invariant violation")]
    VaultBalanceMismatch = 60,
    #[msg("Yes mint supply != No mint supply — invariant violation")]
    MintSupplyMismatch = 61,
    #[msg("Vault cannot cover redemption payout")]
    InsufficientVaultBalance = 62,
    #[msg("SPL token transfer failed")]
    TokenTransferFailed = 63,
    #[msg("SPL token mint_to failed")]
    TokenMintFailed = 64,
    #[msg("SPL token burn failed")]
    TokenBurnFailed = 65,
    #[msg("Associated token account creation failed")]
    ATACreationFailed = 66,

    // === Settlement (on-chain: 6070-6075) ===
    #[msg("Settlement too early — market has not closed yet")]
    SettlementTooEarly = 70,
    #[msg("Admin settle too early — must wait 1 hour after market close")]
    AdminSettleTooEarly = 71,
    #[msg("Override window has expired — outcome is final")]
    OverrideWindowExpired = 72,
    // 73 reserved (removed)
    #[msg("Invalid outcome value")]
    InvalidOutcome = 74,
    #[msg("Maximum override count (3) exceeded — outcome is final")]
    MaxOverridesExceeded = 75,

    // === Redemption (on-chain: 6080-6082) ===
    #[msg("Redemption blocked during override window — try again after deadline")]
    RedemptionBlockedOverride = 80,
    #[msg("No tokens to redeem")]
    NoTokensToRedeem = 81,
    #[msg("Invalid redemption mode")]
    InvalidRedemptionMode = 82,

    // === Crank (on-chain: 6090) ===
    #[msg("Order book is already empty — crank not needed")]
    CrankNotNeeded = 90,

    // === Arithmetic Safety (on-chain: 6100-6101) ===
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow = 100,
    #[msg("Division by zero")]
    DivisionByZero = 101,

    // === Market Closure — Phase 6 (on-chain: 6110-6118) ===
    #[msg("Cannot close an unsettled market")]
    CloseMarketNotSettled = 110,
    #[msg("Cannot close market while override window is active")]
    CloseMarketOverrideActive = 111,
    #[msg("Cannot close market with resting orders — run crank_cancel first")]
    CloseMarketOrderBookNotEmpty = 112,
    // 113 reserved (partial close removed)
    #[msg("Oracle type flag not recognized")]
    InvalidOracleType = 114,
    // 115 reserved (PythFeedMismatch removed — never referenced)
    // 116 reserved (treasury_redeem removed)
    #[msg("Cannot close market — tokens still outstanding")]
    MintSupplyNotZero = 117,
    // 118 reserved (treasury_redeem removed)

    // === ALT Management (on-chain: 6120) ===
    #[msg("Market ALT address has already been set")]
    AltAlreadySet = 120,

    // === Protocol Fees (on-chain: 6130-6131) ===
    #[msg("Fee basis points exceeds maximum (1000 = 10%)")]
    FeeBpsOutOfRange = 130,
    #[msg("Fee vault CPI transfer failed")]
    FeeTransferFailed = 131,

    // === Crank Redeem (on-chain: 6140-6141) ===
    #[msg("Redemption blocked — override window still active")]
    CrankRedeemOverrideActive = 140,
    #[msg("No tokens were redeemed in this batch")]
    CrankRedeemEmpty = 141,

    // === Admin V2 (on-chain: 6150-6163) ===
    #[msg("No pending admin transfer to accept")]
    NoPendingAdmin = 150,
    #[msg("Signer does not match pending admin")]
    NotPendingAdmin = 151,
    #[msg("Withdrawal exceeds available balance (balance - obligations - reserve)")]
    WithdrawalExceedsAvailable = 152,
    #[msg("Ticker already exists in the registry")]
    TickerAlreadyExists = 153,
    #[msg("Ticker not found in the registry")]
    TickerNotFound = 154,
    #[msg("Ticker has been deactivated")]
    TickerDeactivated = 155,
    // 156 reserved (expand_config removed)
    #[msg("Invalid oracle type for Pyth feed validation")]
    PythValidationRequired = 157,
    #[msg("Pyth price account is not valid or has no recent data")]
    InvalidPythFeed = 158,
    #[msg("Cannot switch to Mock oracle while unsettled markets exist")]
    UnsettledMarketsExist = 159,
    #[msg("Invalid operating reserve value")]
    InvalidOperatingReserve = 160,
    #[msg("Settlement blackout must be 0-60 minutes")]
    InvalidBlackoutMinutes = 161,
    #[msg("Treasury has insufficient SOL for rent")]
    InsufficientTreasuryRent = 162,
    #[msg("Admin signer required when oracle_type is Mock")]
    MockOracleAdminRequired = 163,

    // === Sparse Order Book (on-chain: 6170-6175) ===
    #[msg("Order book account data is too small for header")]
    OrderBookTooSmall = 170,
    #[msg("Order book discriminator mismatch")]
    OrderBookDiscriminatorMismatch = 171,
    #[msg("Insufficient SOL for order book rent deposit")]
    InsufficientRentDeposit = 172,
    #[msg("Order book has reached maximum level capacity")]
    MaxLevelsReached = 173,
    // 174 reserved (max slots cap removed)
    #[msg("Order book already initialized")]
    OrderBookAlreadyInitialized = 175,

    #[msg("Override window must be 1-3600 seconds")]
    InvalidOverrideWindow = 176,
}
