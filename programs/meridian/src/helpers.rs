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
        let expiry_day_val = ($market.market_close_unix / 86400) as u32;
        let $expiry_bytes = expiry_day_val.to_le_bytes();
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
