use anchor_lang::prelude::Pubkey;

/// Compute the expiry day from a market_close_unix timestamp.
/// Used in PDA seed derivation to normalize timestamps to day boundaries.
pub const fn expiry_day(market_close_unix: i64) -> u32 {
    (market_close_unix / 86400) as u32
}

/// Parsed fields from an SPL token account's raw data.
/// Layout: mint(32) + owner(32) + amount(8) = 72 bytes minimum.
pub struct TokenAccountFields {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

/// Parse the mint, owner, and amount from raw SPL token account data.
/// Returns `None` if the data is too short (< 72 bytes).
pub fn parse_token_account_fields(data: &[u8]) -> Option<TokenAccountFields> {
    if data.len() < 72 {
        return None;
    }
    Some(TokenAccountFields {
        mint: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
    })
}

/// Constructs the config PDA signer seeds from a GlobalConfig reference.
///
/// # Usage
/// ```ignore
/// let config = &ctx.accounts.config;
/// config_signer_seeds!(config => bump_byte, seeds, signer_seeds);
/// // Now `signer_seeds` is ready for CpiContext::new_with_signer(...)
/// ```
#[macro_export]
macro_rules! config_signer_seeds {
    ($config:expr => $bump_byte:ident, $seeds:ident, $signer_seeds:ident) => {
        let $bump_byte = [$config.bump];
        let $seeds: &[&[u8]] = &[crate::state::GlobalConfig::SEED_PREFIX, &$bump_byte];
        let $signer_seeds = &[$seeds];
    };
}

/// Constructs the market PDA signer seeds from a StrikeMarket reference.
///
/// This macro eliminates the duplicated 6-line seed construction block that
/// appears in every instruction that needs to sign as the market PDA.
///
/// # Usage
/// ```ignore
/// let market = &ctx.accounts.market;
/// market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);
/// // Now `signer_seeds` is ready for CpiContext::new_with_signer(...)
/// ```
///
/// The macro binds intermediate byte arrays to the caller's scope so the
/// borrow checker can verify lifetimes without fighting references-to-temporaries.
#[macro_export]
macro_rules! market_signer_seeds {
    ($market:expr => $strike_bytes:ident, $expiry_bytes:ident, $bump_byte:ident, $seeds:ident, $signer_seeds:ident) => {
        let $strike_bytes = $market.strike_price.to_le_bytes();
        let $expiry_bytes = crate::helpers::expiry_day($market.market_close_unix).to_le_bytes();
        let $bump_byte = [$market.bump];
        let $seeds: &[&[u8]] = &[
            crate::state::StrikeMarket::SEED_PREFIX,
            $market.ticker.as_ref(),
            &$strike_bytes,
            &$expiry_bytes,
            &$bump_byte,
        ];
        let $signer_seeds = &[$seeds];
    };
}
