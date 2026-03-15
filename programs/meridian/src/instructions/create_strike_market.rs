use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, spl_token, Mint, Token, TokenAccount, Transfer};
use crate::error::MeridianError;
use crate::helpers::parse_token_account_fields;
use crate::state::order_book::{HEADER_SIZE, ORDER_BOOK_SEED, init_sparse_book};
use crate::state::{GlobalConfig, StrikeMarket, TickerRegistry};

#[derive(Accounts)]
#[instruction(
    ticker: [u8; 8],
    strike_price: u64,
    expiry_day: u32,
    market_close_unix: i64,
    previous_close: u64,
)]
pub struct CreateStrikeMarket<'info> {
    /// Market creator — can be anyone (admin or regular user).
    /// Non-admin creators pay a strike_creation_fee if configured.
    #[account(mut)]
    pub creator: Signer<'info>,

    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = creator,
        space = 8 + StrikeMarket::LEN,
        seeds = [
            StrikeMarket::SEED_PREFIX,
            ticker.as_ref(),
            &strike_price.to_le_bytes(),
            &expiry_day.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        init,
        payer = creator,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [StrikeMarket::YES_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [StrikeMarket::NO_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// USDC collateral vault — holds $1 × pairs minted
    #[account(
        init,
        payer = creator,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [StrikeMarket::VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// USDC escrow for bid orders (side=0)
    #[account(
        init,
        payer = creator,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [StrikeMarket::ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Yes token escrow for ask orders (side=1)
    #[account(
        init,
        payer = creator,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [StrikeMarket::YES_ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// No token escrow for No-backed bid orders (side=2)
    #[account(
        init,
        payer = creator,
        token::mint = no_mint,
        token::authority = market,
        seeds = [StrikeMarket::NO_ESCROW_SEED, market.key().as_ref()],
        bump,
    )]
    pub no_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: OrderBook PDA — created inline as sparse book (168 bytes).
    /// Address verified via PDA derivation in handler.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

    /// CHECK: Oracle price feed — validated to be owned by the configured oracle program
    #[account(
        constraint = oracle_feed.owner == &config.oracle_program @ MeridianError::OracleProgramMismatch,
    )]
    pub oracle_feed: UncheckedAccount<'info>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ MeridianError::InvalidMint,
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Creator's USDC ATA — fee is deducted from here for non-admin creators.
    /// Optional: only required when creator != admin && strike_creation_fee > 0.
    /// CHECK: Validated in handler when fee transfer is needed.
    #[account(mut)]
    pub creator_usdc_ata: Option<UncheckedAccount<'info>>,

    /// Fee vault — receives strike creation fees.
    /// CHECK: Validated in handler via PDA derivation when fee transfer is needed.
    #[account(mut)]
    pub fee_vault: Option<UncheckedAccount<'info>>,

    /// TickerRegistry — validates ticker is active.
    /// Optional for backward compat: if not provided, falls back to GlobalConfig.tickers.
    /// CHECK: Validated in handler via PDA derivation.
    pub ticker_registry: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_create_strike_market(
    ctx: Context<CreateStrikeMarket>,
    ticker: [u8; 8],
    strike_price: u64,
    _expiry_day: u32,
    market_close_unix: i64,
    previous_close: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;

    // Validate ticker: prefer TickerRegistry if available, fall back to GlobalConfig.tickers
    if let Some(ref registry_info) = ctx.accounts.ticker_registry {
        // Verify PDA derivation
        let (expected_pda, _) = Pubkey::find_program_address(
            &[TickerRegistry::SEED_PREFIX],
            ctx.program_id,
        );
        require!(
            registry_info.key() == expected_pda,
            MeridianError::InvalidTicker,
        );
        // Deserialize and validate
        let registry_data = registry_info.try_borrow_data()?;
        if registry_data.len() >= 8 {
            let registry = TickerRegistry::try_deserialize(&mut &registry_data[..])?;
            require!(
                registry.is_active_ticker(&ticker),
                MeridianError::InvalidTicker,
            );
        } else {
            // Fallback if registry exists but has no data
            require!(config.is_valid_ticker(&ticker), MeridianError::InvalidTicker);
        }
    } else {
        require!(config.is_valid_ticker(&ticker), MeridianError::InvalidTicker);
    }
    require!(strike_price > 0, MeridianError::InvalidStrikePrice);

    // Enforce expiry_day == floor(market_close_unix / 86400) so that
    // PDA seeds are deterministically reconstructable from stored state.
    let expected_expiry_day = crate::helpers::expiry_day(market_close_unix);
    require!(
        _expiry_day == expected_expiry_day,
        MeridianError::InvalidMarketCloseTime
    );

    let clock = Clock::get()?;
    require!(
        market_close_unix > clock.unix_timestamp,
        MeridianError::InvalidMarketCloseTime
    );

    // Charge strike creation fee for non-admin creators
    let creator_key = ctx.accounts.creator.key();
    let fee = config.strike_creation_fee;
    if creator_key != config.admin && fee > 0 {
        let creator_ata = ctx.accounts.creator_usdc_ata
            .as_ref()
            .ok_or(MeridianError::InsufficientAccounts)?;
        let fee_vault_account = ctx.accounts.fee_vault
            .as_ref()
            .ok_or(MeridianError::InsufficientAccounts)?;

        // Validate creator_usdc_ata is an SPL token account with correct mint and owner
        require!(
            creator_ata.owner == &spl_token::ID,
            MeridianError::InvalidMint
        );
        let ata_fields = {
            let data = creator_ata.try_borrow_data()?;
            let fields = parse_token_account_fields(&data);
            drop(data);
            fields
        };
        let ata_fields = ata_fields.ok_or(MeridianError::InvalidMint)?;
        require!(ata_fields.mint == config.usdc_mint, MeridianError::InvalidMint);
        require!(ata_fields.owner == creator_key, MeridianError::SignerMismatch);

        // Validate fee_vault is the correct PDA and is an SPL token account
        let (expected_fee_vault, _) = Pubkey::find_program_address(
            &[GlobalConfig::FEE_VAULT_SEED],
            ctx.program_id,
        );
        require!(
            fee_vault_account.key() == expected_fee_vault,
            MeridianError::InvalidVault
        );
        require!(
            fee_vault_account.owner == &spl_token::ID,
            MeridianError::InvalidVault
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: creator_ata.to_account_info(),
                    to: fee_vault_account.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            fee,
        )?;

        msg!("Strike creation fee charged: {} USDC lamports from {}", fee, creator_key);
    }

    // Initialize the market
    let market = &mut ctx.accounts.market;
    market.config = config.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.usdc_vault = ctx.accounts.usdc_vault.key();
    market.escrow_vault = ctx.accounts.escrow_vault.key();
    market.yes_escrow = ctx.accounts.yes_escrow.key();
    market.no_escrow = ctx.accounts.no_escrow.key();
    market.order_book = ctx.accounts.order_book.key();
    market.oracle_feed = ctx.accounts.oracle_feed.key();
    market.strike_price = strike_price;
    market.market_close_unix = market_close_unix;
    market.total_minted = 0;
    market.total_redeemed = 0;
    market.settlement_price = 0;
    market.previous_close = previous_close;
    market.settled_at = 0;
    market.override_deadline = 0;
    market.alt_address = Pubkey::default();
    market.ticker = ticker;
    market.is_settled = false;
    market.outcome = 0;
    market.override_count = 0;
    market.bump = ctx.bumps.market;

    // Create the OrderBook PDA inline (sparse layout, only 168 bytes)
    let ob_info = ctx.accounts.order_book.to_account_info();
    let (expected_ob, ob_bump) = Pubkey::find_program_address(
        &[ORDER_BOOK_SEED, market.key().as_ref()],
        ctx.program_id,
    );
    require!(
        ob_info.key() == expected_ob,
        MeridianError::InvalidOrderBook
    );
    require!(
        ob_info.data_len() == 0,
        MeridianError::OrderBookAlreadyInitialized
    );

    let market_key_bytes = market.key();
    let ob_seeds: &[&[u8]] = &[
        ORDER_BOOK_SEED,
        market_key_bytes.as_ref(),
        &[ob_bump],
    ];
    let rent = Rent::get()?;
    let ob_lamports = rent.minimum_balance(HEADER_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.creator.key,
            &expected_ob,
            ob_lamports,
            HEADER_SIZE as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.creator.to_account_info(),
            ob_info.clone(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[ob_seeds],
    )?;

    // Initialize sparse book header
    {
        let mut ob_data = ob_info.try_borrow_mut_data()?;
        init_sparse_book(&mut ob_data, &market.key(), ob_bump);
    }

    let ticker_str = std::str::from_utf8(&ticker)
        .unwrap_or("???")
        .trim_end_matches('\0');

    msg!(
        "Market created: ticker={}, strike={}, close_unix={}, market={}",
        ticker_str,
        strike_price,
        market_close_unix,
        market.key(),
    );

    Ok(())
}
