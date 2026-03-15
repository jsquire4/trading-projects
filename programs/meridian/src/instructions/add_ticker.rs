use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::error::MeridianError;
use crate::state::{GlobalConfig, TickerEntry, TickerRegistry};

#[derive(Accounts)]
pub struct AddTicker<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [TickerRegistry::SEED_PREFIX],
        bump = ticker_registry.bump,
    )]
    pub ticker_registry: Box<Account<'info, TickerRegistry>>,

    pub system_program: Program<'info, System>,
}

/// Permissionless — anyone can add a ticker (pays rent for realloc).
/// If the ticker was previously deactivated, reactivates it instead of
/// creating a duplicate. Fails only if the ticker already exists AND is active.
/// When oracle_type == Pyth, requires a valid Pyth price account as
/// remaining_accounts[0].
pub fn handle_add_ticker<'info>(
    ctx: Context<'_, '_, '_, 'info, AddTicker<'info>>,
    ticker: [u8; 8],
) -> Result<()> {
    // M-6: Reject all-zero tickers (uninitialized / empty bytes).
    require!(
        ticker.iter().any(|&b| b != 0),
        MeridianError::InvalidTicker,
    );

    let registry = &mut ctx.accounts.ticker_registry;

    // M-5: Cap registry size to prevent griefing via unbounded growth.
    // Reuses MaxLevelsReached — semantically "capacity exceeded".
    require!(
        registry.entries.len() < 256,
        MeridianError::MaxLevelsReached,
    );

    // Determine pyth_feed based on oracle_type
    let pyth_feed = if ctx.accounts.config.oracle_type == 1 {
        // Pyth mode: validate remaining_accounts[0] is a Pyth price account
        require!(
            !ctx.remaining_accounts.is_empty(),
            MeridianError::PythValidationRequired,
        );
        let pyth_account = &ctx.remaining_accounts[0];
        // Validate: account must have data, be owned by a known Pyth program,
        // and have sufficient size for a Pyth price feed (~3312 bytes).
        require!(
            pyth_account.data_len() >= 3312,
            MeridianError::InvalidPythFeed,
        );
        // Pyth V2 program IDs (mainnet + devnet)
        let pyth_mainnet = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH";
        let pyth_devnet = "gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s";
        let owner_str = pyth_account.owner.to_string();
        require!(
            owner_str == pyth_mainnet || owner_str == pyth_devnet,
            MeridianError::InvalidPythFeed,
        );
        pyth_account.key()
    } else {
        // Mock mode: no validation needed
        Pubkey::default()
    };

    let ticker_str = core::str::from_utf8(&ticker)
        .unwrap_or("?")
        .trim_end_matches('\0');

    // If ticker exists, reactivate if deactivated; error if already active
    if let Some(idx) = registry.find_index(&ticker) {
        require!(
            !registry.entries[idx].is_active,
            MeridianError::TickerAlreadyExists,
        );
        registry.entries[idx].is_active = true;
        registry.entries[idx].pyth_feed = pyth_feed;
        msg!(
            "Ticker reactivated: {} (pyth_feed={}), payer={}",
            ticker_str,
            pyth_feed,
            ctx.accounts.payer.key(),
        );
        return Ok(());
    }

    // New ticker — add entry and realloc
    let new_entry = TickerEntry {
        ticker,
        is_active: true,
        pyth_feed,
        _padding: [0u8; 7],
    };

    registry.entries.push(new_entry);

    // Realloc the account to fit the new entry
    let new_size = TickerRegistry::size_for(registry.entries.len());
    let rent = Rent::get()?;
    let new_min_balance = rent.minimum_balance(new_size);
    let account_info = ctx.accounts.ticker_registry.to_account_info();
    let current_lamports = account_info.lamports();

    let lamports_needed = new_min_balance.saturating_sub(current_lamports);
    if lamports_needed > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: account_info.clone(),
                },
            ),
            lamports_needed,
        )?;
    }

    account_info.realloc(new_size, false)?;

    msg!(
        "Ticker added: {} (pyth_feed={}), payer={}",
        ticker_str,
        pyth_feed,
        ctx.accounts.payer.key(),
    );

    Ok(())
}
