use anchor_lang::prelude::*;

pub mod error;
pub mod state;

pub mod instructions;

// Re-export all items from instruction modules at crate root
// (includes #[derive(Accounts)] structs AND generated __client_accounts_* modules)
pub use instructions::initialize_feed::*;
pub use instructions::update_price::*;

declare_id!("Az6BVaQwfoSqDyyn3TyvgfavoVKN4Qm8wLbMWm5EceFC");

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn initialize_feed(ctx: Context<InitializeFeed>, ticker: [u8; 8]) -> Result<()> {
        instructions::initialize_feed::handle_initialize_feed(ctx, ticker)
    }

    pub fn update_price(
        ctx: Context<UpdatePrice>,
        price: u64,
        confidence: u64,
        timestamp: i64,
    ) -> Result<()> {
        instructions::update_price::handle_update_price(ctx, price, confidence, timestamp)
    }
}
