use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer, spl_token};

use crate::error::MeridianError;
use crate::helpers::parse_token_account_fields;
use crate::state::events::CrankRedeemEvent;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct CrankRedeem<'info> {
    #[account(mut)]
    pub caller: Signer<'info>, // permissionless — anyone can crank

    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        has_one = config @ MeridianError::InvalidMarket,
        has_one = yes_mint @ MeridianError::InvalidMint,
        has_one = no_mint @ MeridianError::InvalidMint,
        has_one = usdc_vault @ MeridianError::InvalidVault,
        constraint = market.is_settled @ MeridianError::MarketNotSettled,
        constraint = market.outcome == 1 || market.outcome == 2 @ MeridianError::InvalidOutcome,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    // remaining_accounts: pairs of (user_winning_ata, user_usdc_ata) per user
}

pub fn handle_crank_redeem<'info>(
    ctx: Context<'_, '_, '_, 'info, CrankRedeem<'info>>,
    batch_size: u8,
) -> Result<()> {
    // Guard: override window must have passed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= ctx.accounts.market.override_deadline,
        MeridianError::CrankRedeemOverrideActive
    );

    let max_users = (batch_size.min(32) as usize) / 2; // 2 accounts per user
    let remaining = ctx.remaining_accounts;

    // Must have pairs of accounts
    require!(
        remaining.len() >= 2 && remaining.len() % 2 == 0,
        MeridianError::InsufficientAccounts
    );

    let market = &ctx.accounts.market;
    let outcome = market.outcome;

    // Determine which mint is the winning mint
    let winning_mint_key = match outcome {
        1 => market.yes_mint,
        2 => market.no_mint,
        _ => return err!(MeridianError::InvalidOutcome),
    };

    // Build market PDA signer seeds for burn (market is mint authority)
    market_signer_seeds!(market => strike_bytes, expiry_bytes, bump_byte, seeds, signer_seeds);

    let tp = ctx.accounts.token_program.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();

    let winning_mint_ai = match outcome {
        1 => ctx.accounts.yes_mint.to_account_info(),
        _ => ctx.accounts.no_mint.to_account_info(),
    };

    let usdc_mint_key = ctx.accounts.config.usdc_mint;
    let mut redeemed_count: u32 = 0;
    let mut total_redeemed_amount: u64 = 0;

    let num_pairs = (remaining.len() / 2).min(max_users);

    for i in 0..num_pairs {
        let user_winning_ata = &remaining[i * 2];
        let user_usdc_ata = &remaining[i * 2 + 1];

        // Validate winning ATA is an SPL token account
        if user_winning_ata.owner != &spl_token::ID {
            continue; // Skip invalid accounts gracefully
        }
        if user_usdc_ata.owner != &spl_token::ID {
            continue;
        }

        // Parse winning ATA fields
        let winning_fields = {
            let data = user_winning_ata.try_borrow_data()?;
            let fields = parse_token_account_fields(&data);
            drop(data);
            fields
        };
        let winning_fields = match winning_fields {
            Some(f) => f,
            None => continue,
        };

        // Validate mint matches winning token
        if winning_fields.mint != winning_mint_key {
            continue;
        }

        // Skip zero-balance accounts
        if winning_fields.amount == 0 {
            continue;
        }

        // Parse USDC ATA fields
        let usdc_fields = {
            let data = user_usdc_ata.try_borrow_data()?;
            let fields = parse_token_account_fields(&data);
            drop(data);
            fields
        };
        let usdc_fields = match usdc_fields {
            Some(f) => f,
            None => continue,
        };

        // Validate USDC ATA mint
        if usdc_fields.mint != usdc_mint_key {
            continue;
        }

        // Validate both ATAs belong to the same owner
        if winning_fields.owner != usdc_fields.owner {
            continue;
        }

        // Check delegation and account state before attempting burn.
        // SPL Token account layout:
        //   delegate: COption<Pubkey> at offset 72 (4-byte discriminant + 32-byte key)
        //   state:    u8 at offset 108 (0=Uninitialized, 1=Initialized, 2=Frozen)
        let winning_data2 = user_winning_ata.try_borrow_data()?;
        if winning_data2.len() < 109 {
            drop(winning_data2);
            continue; // Account too small to have delegate + state fields
        }

        // Skip frozen accounts (state == 2) — burn CPI would revert the whole batch
        let account_state = winning_data2[108];
        if account_state != 1 {
            drop(winning_data2);
            continue; // Not in Initialized state — skip
        }

        let delegate_option = u32::from_le_bytes(winning_data2[72..76].try_into().unwrap());
        if delegate_option != 1 {
            drop(winning_data2);
            continue; // No delegate set — user must redeem manually
        }
        let delegate_key = Pubkey::new_from_array(winning_data2[76..108].try_into().unwrap());

        // Parse delegated_amount (u64 LE at offset 121) to ensure the delegate
        // is approved for enough tokens; skip if insufficient to avoid reverting
        // the entire batch.
        let delegated_amount = u64::from_le_bytes(
            winning_data2[121..129].try_into().unwrap(),
        );
        drop(winning_data2);

        if delegate_key != market.key() {
            continue; // Delegate is not the market PDA — skip
        }

        if delegated_amount < winning_fields.amount {
            continue; // Delegate approved for less than balance — skip, user must redeem manually
        }

        // Burn winning tokens (market PDA is the approved delegate)
        token::burn(
            CpiContext::new_with_signer(
                tp.clone(),
                Burn {
                    mint: winning_mint_ai.clone(),
                    from: user_winning_ata.to_account_info(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            winning_fields.amount,
        )?;

        // Transfer USDC from vault to user ($1 per winning token)
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: user_usdc_ata.to_account_info(),
                    authority: market_ai.clone(),
                },
                signer_seeds,
            ),
            winning_fields.amount,
        )?;

        total_redeemed_amount += winning_fields.amount;
        redeemed_count += 1;
    }

    require!(redeemed_count > 0, MeridianError::CrankRedeemEmpty);

    // Update market total_redeemed
    let market = &mut ctx.accounts.market;
    market.total_redeemed = market
        .total_redeemed
        .checked_add(total_redeemed_amount)
        .ok_or(MeridianError::ArithmeticOverflow)?;

    emit!(CrankRedeemEvent {
        market: market.key(),
        redeemed_count,
        total_usdc_redeemed: total_redeemed_amount,
    });

    msg!(
        "Crank redeem: market={}, redeemed={} users, amount={} USDC lamports",
        market.key(),
        redeemed_count,
        total_redeemed_amount,
    );

    Ok(())
}
