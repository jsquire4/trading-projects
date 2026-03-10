# Meridian — Architecture

## System Overview

Meridian is a binary stock outcome trading platform on Solana. Users trade Yes/No tokens on whether MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) close above a strike price on a given trading day. Contracts are 0DTE, settle at 4 PM ET via real Tradier API data, and pay $1 USDC to winning token holders. Losing tokens burn for $0. Each Yes token and its paired No token always sum to exactly $1 (the Arrow-Debreu complete-market identity).

### Top-Level Components

| Layer | Component | Role |
|---|---|---|
| On-chain | `meridian` program | Trading engine: markets, order book, settlement, redemption |
| On-chain | `mock_oracle` program | Price feeds for devnet; swappable for Pyth on mainnet |
| Off-chain | Next.js 14 frontend | Wallet-connected trading UI and analytics dashboard |
| Off-chain | Oracle feeder service | Tradier WebSocket → on-chain PriceFeed updates |
| Off-chain | Market initializer | Morning job; vol-aware strike selection; market creation |
| Off-chain | AMM bot | Black-Scholes N(d2) pricer; seeds every market with quotes |
| Off-chain | Event indexer | On-chain log parsing → SQLite; REST API for frontend |
| Off-chain | Settlement scheduler | Calls `settle_market` at 4 PM ET; cranks `crank_cancel` |

---

## Why Solana

### Fit for This Product

Solana's programming model maps cleanly to every design requirement Meridian has:

- **Sub-second finality**: Order placement and fills confirm in ~400ms. For a 0DTE product where market conditions change rapidly, this is the minimum acceptable latency.
- **Low per-transaction fees**: $0.001/tx means AMM quoting, crank cleanup, and oracle updates are economically viable at prototype scale without batching tricks.
- **SPL Token model**: Fungible tokens with associated token accounts are a natural fit for Yes/No outcome tokens. Mint, transfer, and burn are first-class operations with standardized wallet support.
- **Anchor framework**: Typed account validation, automatic serialization, IDL generation, and bankrun testing — the full development stack is mature and well-documented.
- **ZeroCopy accounts**: The ~126KB OrderBook is memory-mapped directly rather than deserialized on each access, keeping compute units flat regardless of book depth.
- **v0 versioned transactions + ALTs**: Address Lookup Tables compress 32-byte pubkeys to 1-byte indices, making complex multi-account instructions (e.g., No-backed bid merge/burn) fit within transaction size limits.

### Alternatives Considered

**HyperLiquid**: Evaluated in full — see `HYPERLIQUID_FEASIBILITY.md`. The short version: HyperLiquid's native order book is permissioned (can't self-list custom instruments), and using it as a generic EVM chain (HyperEVM) produces an on-chain CLOB with worse gas economics than Solana and no HyperLiquid-specific benefit.

**Arbitrum/Base (EVM L2)**: General-purpose EVM with low fees. No ZeroCopy equivalent; a 99-level × 16-slot order book in Solidity storage mappings is significantly more expensive to iterate than Solana's flat memory layout. Anchor's account model has no direct equivalent; all PDA patterns, account validation, and CPI would need to be rebuilt from scratch.

**Raw Solana without Anchor**: Too low-level. No automatic (de)serialization, no typed account constraints, no IDL. All validation code would need to be written manually — significant development time with no benefit.

---

## On-Chain Architecture

### Program Design

**`meridian`** (main program): All trading logic lives here. Manages GlobalConfig (one per deployment), StrikeMarket (one per ticker/strike/date), OrderBook (one per market), mints, and vaults. Exposes 15 instructions across Phases 1–6.

**`mock_oracle`**: Separate program that maintains PriceFeed accounts (one per ticker). Fed by the oracle feeder service. Swappable for Pyth on mainnet via the `oracle_type` field in GlobalConfig — `settle_market` branches on `oracle_type` to choose the deserialization path. The two programs are decoupled: upgrading or replacing the oracle program does not require redeploying meridian.

### Account Model

| Account | Size | Role |
|---|---|---|
| GlobalConfig | 192 bytes | One per deployment. Stores admin key, USDC mint, oracle program, staleness thresholds, pause flag, supported tickers. |
| StrikeMarket | 408 bytes | One per market. Stores all market PDAs (mints, vaults, escrows, order book, oracle feed), strike price, settlement data, outcome, pause and closure flags. |
| OrderBook | ~126 KB (ZeroCopy) | One per market. 99 price levels, 16 order slots per level. Memory-mapped; not deserialized on access. |
| Yes Mint / No Mint | 82 bytes each | SPL Token mints. Mint authority and freeze authority are both the market PDA. |
| USDC Vault | SPL token account | Holds mint collateral ($1 per pair minted). Vault balance = (total_minted − total_redeemed) × 1_000_000 lamports. |
| Escrow Vault | SPL token account | Holds USDC from resting USDC bids (Buy Yes limit orders). |
| Yes Escrow | SPL token account | Holds Yes tokens from resting Yes asks (Sell Yes limit orders). |
| No Escrow | SPL token account | Holds No tokens from resting No-backed bids (Sell No limit orders). |
| PriceFeed | ~100 bytes | Mock oracle. Stores price, confidence, timestamp, authority. One per ticker. |
| Treasury | SPL token account | Single USDC account owned by GlobalConfig PDA. Receives unclaimed USDC from force-closed markets (Phase 6). |

### PDA Derivation Scheme

All accounts are Program Derived Addresses. Seeds are deterministic so any client can derive them without on-chain lookup.

| Account | Seeds |
|---|---|
| GlobalConfig | `[b"config"]` |
| StrikeMarket | `[b"market", ticker_bytes_8, strike_price_le_u64, expiry_day_le_u32]` |
| Yes Mint | `[b"yes_mint", market.key()]` |
| No Mint | `[b"no_mint", market.key()]` |
| USDC Vault | `[b"vault", market.key()]` |
| Escrow Vault | `[b"escrow", market.key()]` |
| Yes Escrow | `[b"yes_escrow", market.key()]` |
| No Escrow | `[b"no_escrow", market.key()]` |
| OrderBook | `[b"order_book", market.key()]` |
| PriceFeed | `[b"price_feed", ticker_bytes_8]` |
| Treasury | `[b"treasury"]` |

`ticker_bytes_8` is the ticker string UTF-8 padded to 8 bytes with zeros. `strike_price` is USDC lamports as a u64 little-endian (e.g., 680_000_000 for $680.00). `expiry_day` is `floor(market_close_unix / 86400)` as a u32 little-endian.

### Order Book Design

The OrderBook is a custom 99-level Central Limit Order Book (CLOB). Design choices:

- **Price representation**: u8 in range [1, 99]. Price 50 = $0.50 per Yes token. Prices outside [1, 99] are rejected.
- **Level structure**: 99 `PriceLevel` entries (index 0 = price 1, index 98 = price 99). Each level holds up to 16 `OrderSlot` entries and a count.
- **FIFO per level**: Orders at the same price fill in arrival order (price-time priority).
- **Three order sides**: USDC bid (side=0, Buy Yes), Yes ask (side=1, Sell Yes), No-backed bid (side=2, Sell No). All three types coexist on the same book.
- **Matching rule**: `bid_price >= ask_price`. Execution at the resting order's price.
- **ZeroCopy layout**: `#[account(zero_copy)]` with `repr(C)`. The ~126KB account is pre-allocated in ~13 incremental calls (Solana's `MAX_PERMITTED_DATA_INCREASE` limit is 10,240 bytes per CPI). Bankrun tests bypass this with `context.setAccount()`.

**No-Backed Bid (Sell No) mechanics**: A user wanting to sell No at $0.40 posts a No-backed bid at price 60 (inverted: 100 − 40 = 60), escrowing their No tokens into `no_escrow`. When a Yes ask at price 60 crosses this bid, the matching engine merge/burns both tokens (Yes from `yes_escrow` + No from `no_escrow`), releases $1 from the vault, and pays $0.60 to the Yes seller and $0.40 to the No seller. This is the standard merge/burn primitive used by Polymarket (MERGE trade type), Augur (`sellCompleteSets`), and Gnosis CTF (`mergePositions`).

### Token Model

- **Minting**: `mint_pair` accepts $1 USDC, credits 1_000_000 Yes lamports + 1_000_000 No lamports to the caller's ATAs. Vault balance increases by $1. `total_minted` increments.
- **Trading**: Yes tokens and No tokens trade on the order book. USDC flow depends on order side and match type (standard swap or merge/burn).
- **Settlement**: `settle_market` reads the oracle at market close, compares to strike using `>=`, and sets `outcome` to YesWins (1) or NoWins (2). Pair burn redemptions are always available (outcome-independent). Winner/loser redemption is blocked during the 1-hour override window.
- **Redemption**: `redeem` burns winning tokens for $1 USDC each, burns losing tokens for $0. `total_redeemed` increments. Vault invariant: `vault_balance == (total_minted − total_redeemed) × 1_000_000`.

---

## Off-Chain Architecture

### Frontend (Next.js 14)

- **App Router**: API routes (`/api/tradier/*`) proxy Tradier REST calls with 60-second TTL caching, preventing rate limit exhaustion from concurrent users.
- **Wallet integration**: `@solana/wallet-adapter` with Phantom/Solflare support. All trading transactions are v0 versioned transactions using per-market ALTs.
- **Data fetching**: TanStack Query polls on-chain accounts (order book depth, market state, user positions) and REST endpoints (live prices, options chains, historical data) with stale-while-revalidate semantics.
- **Analytics dashboard**: Options comparison (Tradier delta vs Meridian implied probability), historical return overlay (252-day return distribution), settlement calibration chart, binary greeks display (delta, gamma).
- **Node.js polyfills**: `next.config.js` adds webpack fallbacks for `crypto`, `stream`, and `buffer` — required by Anchor's TypeScript client.

### Oracle Feeder Service

Connects to Tradier's streaming WebSocket via a REST session endpoint, then streams all 7 MAG7 symbols on a single connection. On each price tick, calls `update_price_feed` on the mock oracle program, writing the new price, confidence band, and timestamp to the relevant PriceFeed account. Zero REST calls during steady-state operation.

### Market Initializer

Runs once at market open. Sequence:
1. Fetch the Tradier market clock to confirm the session is open and get the exact close time (handles half-days).
2. Fetch batch quotes for all 7 tickers (1 REST call) to get previous close prices.
3. Fetch 60-day OHLCV history for each ticker (7 REST calls) to compute 20-day historical volatility (HV20).
4. Calculate strikes at 1σ / 1.5σ / 2σ levels around the previous close (vol-aware, rather than fixed ±3/6/9%).
5. Call `create_strike_market` for each ticker/strike combination, then create and populate the per-market ALT.

### AMM Bot

Quotes every market on a configurable interval. Pricing model:
- **N(d2) formula** from Black-Scholes binary options: `P(Yes wins) = N(d2)` where `d2 = (ln(S/K) + (−σ²/2)T) / (σ√T)`.
- **Inventory skew**: If the bot holds more Yes than No (or vice versa), it shifts quotes to reduce the imbalance.
- **Circuit breaker**: If the bot's net exposure exceeds a configurable threshold, it stops quoting until inventory is reconciled.
- **Reconciliation**: Before each quote cycle, the bot checks its own Yes/No balances and burns any complete pairs (calls `redeem`) to free up USDC for re-quoting.

### Event Indexer

Subscribes to Anchor-emitted program logs and parses `FillEvent` and `SettlementEvent` structured events. Writes to SQLite via `better-sqlite3`. Exposes a REST API used by the settlement analytics and leaderboard features. Designed to be restartable — on startup it queries the RPC for historical logs since the last indexed slot.

### Settlement Scheduler

Monitors time and polls market state. At or after `market_close_unix`, calls `settle_market` (permissionless, anyone can call). If the oracle is stale or unavailable after a 1-hour delay, falls back to `admin_settle`. After settlement, calls `crank_cancel` in a loop until the order book is empty (all resting escrows returned to their owners).

---

## Data Flow

**Order Placement**:
1. Frontend composes a v0 transaction using the market's ALT.
2. User's wallet signs. Transaction lands on-chain in ~400ms.
3. `place_order` validates market state, escrows the appropriate asset (USDC, Yes, or No), runs the matching engine against resting orders, emits `FillEvent` for each fill.
4. If unfilled quantity remains, it rests on the order book.

**Settlement**:
1. At 4 PM ET, oracle feeder writes the closing price to the PriceFeed account.
2. Settlement scheduler calls `settle_market`. The instruction reads the oracle (validates staleness ≤ 120s, confidence ≤ 0.5% of price), compares to strike, sets `outcome` and `override_deadline`.
3. Admin has 1 hour to call `admin_override_settlement` if the oracle price is incorrect.
4. Scheduler calls `crank_cancel` repeatedly until the order book is empty.

**Redemption**:
1. After the 1-hour override window, `redeem` becomes available for winner/loser tokens.
2. Winners call `redeem` — Yes (or No) tokens burn, $1 USDC transfers from vault to user's USDC ATA.
3. Losers call `redeem` — tokens burn for $0.
4. Pair redeem (`redeem` with both Yes and No tokens) is always available regardless of settlement status.

---

## Trade-offs and Design Decisions

### Custom Order Book vs Phoenix DEX

Phoenix is a production CLOB on Solana. Using it would have provided a battle-tested matching engine but at the cost of full control. Meridian's three-sided order book (USDC bids, Yes asks, No-backed bids) and merge/burn settlement are not supported by Phoenix's standard spot book. Building custom gives atomic integration with the vault invariant and no dependency on external program upgrades.

### Mock Oracle vs Pyth

Pyth has no MAG7 equity feeds on Solana devnet. A mock oracle program (same interface, different authority) provides identical settlement logic without devnet data gaps. The `oracle_type` field in GlobalConfig and the branching logic in `settle_market` mean switching to Pyth on mainnet is a configuration change plus a new deserialization path — not a rewrite.

### SPL Token vs Token-2022

Token-2022 adds transfer hooks, confidential transfers, and PermanentDelegate (which would allow force-burning user tokens for full mint cleanup). None of these are needed for the prototype. PermanentDelegate in particular is a trust liability — it gives the admin unilateral power to burn any user's tokens at any time, undermining the non-custodial value proposition. SPL Token has broader wallet support, more battle-tested tooling, and is sufficient for all Phases 1–5 requirements.

### v0 Versioned Transactions + ALTs

Every market gets an Address Lookup Table created as part of the market creation flow. The ALT is pre-loaded with all 14 market-related accounts (market PDA, config, order book, mints, vaults, escrows, oracle feed, token programs, system program). This compresses account references from 32 bytes to 1 byte each — a 22-account instruction drops from ~700 bytes of keys to ~22 bytes, ensuring transaction size is never a constraint even for the most complex instructions.

### 90-Day Redemption Window (Phase 6)

The spec says unredeemed tokens are redeemable indefinitely. On mainnet, open accounts consume rent indefinitely. The three-phase closure lifecycle (`close_market` at 90 days, `treasury_redeem` with no deadline, `cleanup_market` once supply hits zero) reclaims ~98% of rent at 90 days while preserving indefinite user recourse via the Treasury PDA. The 90-day window is when funds move from the market vault to treasury, not when user rights expire.
