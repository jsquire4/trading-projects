# Meridian Architecture Analysis

**Generated from actual codebase analysis** (not documentation)

## System Overview

Meridian is a **binary stock outcome trading platform** built on Solana. It enables 0DTE (zero days to expiry) binary options trading where users can:
- Buy/sell "Yes" tokens (pays $1 if stock closes above strike)
- Buy/sell "No" tokens (pays $1 if stock closes below strike)
- Trade on an on-chain order book with automated market making

**Tech Stack:**
- **On-chain**: Anchor (Rust) program on Solana
- **Services**: Node.js/TypeScript microservices
- **Frontend**: Next.js 14 (React) with Solana wallet integration

---

## 1. Anchor Program Architecture

### Programs

#### Meridian Program
**Program ID**: `7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth` (devnet)

Main trading engine with order book, minting, settlement, and redemption.

#### Mock Oracle Program
**Program ID**: `HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ` (devnet)

Simple price feed oracle for devnet. Stores price feeds that can be updated by an authority. On mainnet, this would be replaced with Pyth Network.

**Instructions**:
- `initialize_feed`: Creates a PriceFeed account for a ticker
- `update_price`: Updates price, confidence, and timestamp (authority-only)

**PriceFeed Account** (72 bytes):
- ticker: [u8; 8]
- price: u64 (USDC lamports, 6 decimals)
- confidence: u64 (confidence band width)
- timestamp: i64 (unix timestamp)
- authority: Pubkey (who can update)
- is_initialized: bool
- bump: u8

---

## 2. Meridian Program Details (`programs/meridian`)

### Core State Accounts

#### GlobalConfig (184 bytes)
**PDA**: `[b"config"]`

Stores global protocol configuration:
- Admin authority
- USDC mint address
- Oracle program ID
- Staleness thresholds, confidence bounds
- Supported tickers array (7 MAG7 stocks: AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA)
- Global pause flag
- Oracle type (Mock vs Pyth)

#### StrikeMarket (400 bytes)
**PDA**: `[b"market", ticker_bytes_8, strike_price_le_u64, expiry_day_le_u32]`

Per-market state account containing:
- **Market PDAs**: yes_mint, no_mint, usdc_vault, escrow_vault, yes_escrow, no_escrow, order_book, oracle_feed
- **Market data**: strike_price, market_close_unix, total_minted, total_redeemed
- **Settlement**: settlement_price, outcome (0/1/2), override_deadline
- **Flags**: is_settled, is_paused, is_closed, override_count

#### OrderBook (~127KB, ZeroCopy)
**PDA**: `[b"order_book", market.key()]`

Massive ZeroCopy account storing the entire order book:
- **99 price levels** (1-99 cents)
- **16 order slots per level** (FIFO within level)
- **Three order sides**:
  - `SIDE_USDC_BID` (0): Buy Yes — escrows USDC
  - `SIDE_YES_ASK` (1): Sell Yes — escrows Yes tokens
  - `SIDE_NO_BID` (2): Sell No — escrows No tokens (No-backed bid)

**Memory Layout:**
- `OrderSlot`: 80 bytes (owner, order_id, quantity, original_quantity, side, timestamp, is_active)
- `PriceLevel`: 1,288 bytes (16 slots + count + padding)
- `OrderBook`: 127,560 bytes total

### Instructions (17 total)

#### Initialization Phase
1. **`initialize_config`**: Creates GlobalConfig with tickers and oracle settings
2. **`create_strike_market`**: Creates a new market with Yes/No mints, vaults, escrows
3. **`allocate_order_book`**: Incrementally allocates the 127KB OrderBook account (13 calls)
4. **`set_market_alt`**: Sets Address Lookup Table for market (reduces transaction size)

#### Trading Phase
5. **`mint_pair`**: Mints 1 Yes + 1 No token for $1 USDC (always available)
   - **Position constraint**: Enforces user has no existing Yes or No tokens (on-chain check)
6. **`place_order`**: Core trading instruction — matches and places orders
   - **Position constraints**: 
     - USDC bids require no No token position
     - No bids require no Yes token position
     - Enforced on-chain via `reload()` for composable transaction safety
7. **`cancel_order`**: Cancels a resting order by (price, order_id)

#### Admin Phase
8. **`pause`**: Pauses global or per-market trading
9. **`unpause`**: Resumes trading

#### Settlement Phase
10. **`settle_market`**: Permissionless settlement using oracle price
11. **`admin_settle`**: Admin override settlement (1 hour delay after market close)
12. **`admin_override_settlement`**: Override settlement price (1 hour window, max 3 overrides)

#### Redemption Phase
13. **`redeem`**: Redeem tokens post-settlement (pair burn or winner redeem)
14. **`crank_cancel`**: Batch cancel resting orders on settled markets (up to 32 per call)

#### Cleanup Phase
15. **`close_market`**: Close market after 90 days post-settlement
16. **`treasury_redeem`**: Admin redeem remaining tokens from closed markets
17. **`cleanup_market`**: Final cleanup (closes accounts)

---

## 3. Order Book Implementation

### Storage Structure

The order book uses **ZeroCopy** for efficient on-chain access without deserialization:

```
OrderBook (127,560 bytes)
├── market: Pubkey (32 bytes)
├── next_order_id: u64 (8 bytes)
├── levels: [PriceLevel; 99] (99 × 1,288 = 127,512 bytes)
│   ├── orders: [OrderSlot; 16] (16 × 80 = 1,280 bytes)
│   ├── count: u8 (1 byte)
│   └── padding: [u8; 7] (7 bytes)
└── bump + padding: u8 + [u8; 7] (8 bytes)
```

### Order Placement Flow (`place_order.rs`)

1. **Validation**: Checks side (0/1/2), price (1-99), quantity (≥1 token), order type (market/limit)
2. **Position Constraints** (On-chain enforcement):
   - **USDC bids** (Buy Yes): Requires `user_no_ata.amount == 0` → `ConflictingPosition` error
   - **No bids** (Sell No): Requires `user_yes_ata.amount == 0` → `ConflictingPosition` error
   - Uses `reload()` to get fresh balances for composable transaction safety
   - Prevents users from holding conflicting positions (e.g., buying Yes while holding No)
3. **Escrow Assets**:
   - USDC bid: escrows `ceil(quantity * price / 100)` USDC
   - Yes ask: escrows Yes tokens
   - No bid: escrows No tokens
4. **Matching Engine**: Runs against resting orders (see below)
5. **Process Fills**:
   - Standard swap: transfers tokens, pays makers from escrow
   - Merge/burn: burns Yes+No, distributes $1 from vault
6. **Resting Order**: Places remaining quantity on book if limit order
7. **Refund**: Returns unfilled escrow for market orders or dust

### Matching Engine (`matching/engine.rs`)

**Price-time priority matching** with three order types:

#### Standard Swap: USDC Bid × Yes Ask
- **USDC bids** (side=0): Walk asks from lowest price upward
- **Yes asks** (side=1): Walk bids from highest price downward
- **Matching condition**: `bid_price >= ask_price`
- **Execution**: Executes at resting order price (price improvement for taker)

#### Merge/Burn: No Bid × Yes Ask
- **No bids** (side=2): Walk Yes asks where `yes_ask_price + no_bid_price <= 100`
- **Matching condition**: `no_bid_price + yes_ask_price <= 100`
- **Execution**: Burns Yes+No tokens, distributes $1 from vault
  - No seller gets `$(no_bid_price / 100)`
  - Yes seller gets `$((100 - no_bid_price) / 100)`

**Key Functions:**
- `match_order()`: Main entry point
- `match_against_asks()`: USDC bid matching
- `match_against_bids()`: Yes ask matching (checks both USDC and No bids)
- `match_against_asks_merge()`: No bid merge matching
- `match_at_level_for_side()`: Core matching at price level (FIFO within level)
- `place_resting_order()`: Places limit orders on book

### Order Lifecycle

1. **Place**: Order escrows assets, matches against book, rests if limit
2. **Fill**: Partial or full fill updates resting order quantity
3. **Cancel**: User cancels resting order, escrow refunded
4. **Crank Cancel**: Post-settlement batch cancellation

---

## 4. Services Architecture

### Service Overview

All services are Node.js/TypeScript microservices that interact with the Solana program:

```
┌─────────────────┐
│  automation     │ → Scheduler (8 AM, 4 PM ET)
├─────────────────┤
│  market-        │ → Creates markets at 8 AM
│  initializer    │
├─────────────────┤
│  oracle-feeder  │ → Streams prices from Tradier WebSocket
├─────────────────┤
│  amm-bot        │ → Automated market maker (30s polling)
├─────────────────┤
│  settlement     │ → Settles markets at 4 PM
├─────────────────┤
│  event-indexer  │ → Indexes events to SQLite + REST API
├─────────────────┤
│  monitor        │ → Health checks and alerting
└─────────────────┘
```

### amm-bot (`services/amm-bot/`)

**Purpose**: Automated market maker seeding liquidity

**Architecture**:
- **Main loop**: Polls active markets every 30 seconds
- **Pricing**: Black-Scholes binary option formula `N(d2)`
- **Quote generation**: Two-sided quotes with inventory skew
- **Execution**: Places quotes on-chain via `place_order`

**Key Files**:
- `index.ts`: Main polling loop
- `pricer.ts`: Black-Scholes pricing (`binaryCallPrice()`)
- `quoter.ts`: Quote generation with inventory skew
- `executor.ts`: On-chain execution

**Features**:
- Inventory tracking: Adjusts quotes based on bot's Yes/No balance
- Circuit breaker: Halts if inventory exceeds threshold
- Reconciliation: Burns complete pairs before quoting to free USDC
- Historical volatility: Fetches from Tradier (20-day HV)

### event-indexer (`services/event-indexer/`)

**Purpose**: Indexes on-chain events to SQLite for frontend queries

**Architecture**:
1. **Backfill**: Fetches historical events from last checkpoint
2. **Live listener**: Subscribes to logs via `connection.onLogs`
3. **Event parsing**: Parses Anchor events from transaction logs
4. **Database**: SQLite with deduplication
5. **REST API**: Exposes `/api/events`, `/api/markets/:market/fills`

**Events Indexed**:
- `FillEvent`: Trade fills (maker, taker, price, quantity, sides, is_merge)
- `SettlementEvent`: Market settlements (ticker, strike, settlement_price, outcome)
- `CrankCancelEvent`: Batch cancellations (market, cancelled_count)

**Key Files**:
- `index.ts`: Entry point
- `listener.ts`: Live subscription handler
- `backfill.ts`: Historical event fetching
- `db.ts`: SQLite operations
- `api.ts`: REST server

### settlement (`services/settlement/`)

**Purpose**: Daily settlement at 4 PM ET

**Flow**:
1. Fetch closing prices from Tradier API
2. Update mock oracle price feeds (with retries)
3. Call `settle_market` for expired markets (permissionless)
4. Crank `crank_cancel` until order books empty
5. Close markets eligible for 90-day closure

**Key Files**:
- `index.ts`: Main entry
- `settler.ts`: Settlement logic
- `cranker.ts`: Cancel batch processing
- `closer.ts`: Market closure

### market-initializer (`services/market-initializer/`)

**Purpose**: Creates markets at market open (8 AM ET)

**Flow**:
1. Fetch Tradier market clock and previous close prices
2. Compute 20-day historical volatility
3. Calculate strikes at 1σ, 1.5σ, 2σ levels around previous close
4. Call `create_strike_market` for each ticker/strike combo
5. Create and populate Address Lookup Tables (ALTs)
6. Call `set_market_alt` to link ALT to market

**Key Files**:
- `index.ts`: Entry point
- `initializer.ts`: Market creation logic
- `strikeSelector.ts`: Strike calculation
- `verify.ts`: Post-creation verification
- `alt.ts`: ALT creation

### oracle-feeder (`services/oracle-feeder/`)

**Purpose**: Streams real-time prices from Tradier WebSocket to on-chain oracle

**Flow**:
1. Read active tickers from GlobalConfig
2. Connect to Tradier streaming WebSocket
3. On price tick, call `update_price_feed` on mock oracle program
4. Updates PriceFeed account with price, confidence, timestamp

**Key Files**:
- `index.ts`: Main loop
- `feeder.ts`: WebSocket handler

### automation (`services/automation/`)

**Purpose**: DST-aware scheduler for daily jobs

**Schedule**:
- **08:00 ET**: Trigger market-initializer
- **08:30 ET**: Verify markets created
- **16:05 ET**: Trigger settlement service
- **16:10 ET**: Verify settlement completed

**Key Files**:
- `index.ts`: Main scheduler
- `scheduler.ts`: Cron logic
- `timezone.ts`: DST handling

### monitor (`services/monitor/`)

**Purpose**: Health checks and alerting

**Checks**:
- Admin SOL balance (< 0.1 SOL alert)
- Oracle freshness during market hours
- Unsettled expired markets
- Closeable markets (settled + 90 days)

**Key Files**:
- `index.ts`: Main loop
- `checker.ts`: Health check logic

### shared (`services/shared/`)

Common utilities:
- `pda.ts`: PDA derivation functions
- `tradier-client.ts`: Tradier API client
- `volatility.ts`: Historical volatility calculations
- `idl/`: IDL types (meridian.json, mock_oracle.json)
- `alerting.ts`: Logging and alerting
- `strikes.ts`: Strike calculation utilities

---

## 5. Web App Architecture (`app/meridian-web`)

### Framework
- **Next.js 14** (App Router)
- **React 18** with TypeScript
- **TanStack Query** for server state
- **Solana Wallet Adapter** for wallet integration

### Key Pages

- **`/`** (`page.tsx`): Homepage with market summaries
- **`/trade`**: Market browser
- **`/trade/[ticker]`**: Per-ticker market list
- **`/portfolio`**: User positions, orders, PnL
- **`/analytics`**: Options comparison, historical overlays, Greeks
- **`/history`**: Trade history (from event indexer API)
- **`/market-maker`**: AMM bot dashboard

### Key Hooks (`hooks/`)

- **`useMarkets`**: Fetches all StrikeMarket accounts (10s polling)
- **`useMarket`**: Single market by pubkey
- **`useOrderBook`**: Deserializes OrderBook account, builds Yes/No views
- **`useAnchorProgram`**: Typed Anchor program instance
- **`usePositions`**: User's Yes/No token balances
- **`useMyOrders`**: User's resting orders from order book
- **`useCancelOrder`**: Cancel order hook
- **`useCostBasis`**: Cost basis tracking
- **`useKeyboardShortcuts`**: Keyboard shortcuts
- **`useMarketSummaries`**: Market summary data
- **`useNetwork`**: Network detection
- **`usePortfolioSnapshot`**: Portfolio snapshot
- **`useTransaction`**: Transaction handling
- **`useWalletState`**: Wallet state management
- **`useWatchlist`**: Watchlist management
- **`useAnalyticsData`**: Analytics data fetching

### Key Components

#### Trading Components
- **`OrderForm`**: Place orders (Buy Yes, Sell Yes, Buy/Sell No)
- **`OrderBook`**: Visual order book display
- **`DepthChart`**: Order book depth visualization
- **`MarketCard`**: Market summary card
- **`MarketInfo`**: Detailed market information
- **`PayoffDisplay`**: Payoff diagram
- **`TradeConfirmationModal`**: Transaction confirmation
- **`TradeModal`**: Trade interface modal
- **`FillFeed`**: Live fill feed display
- **`LiveFillTicker`**: Real-time fill ticker

#### Portfolio Components (`components/portfolio/`)
- **`PositionsTab`**: User's Yes/No token positions
- **`OpenOrdersTab`**: Resting orders
- **`TradeHistoryTab`**: Historical trades
- **`PnlTab`**: Profit & loss calculations
- **`MyPositions`**: Position summary
- **`MyOrders`**: Order management

#### Analytics Components (`components/analytics/`)
- **`OptionsComparison`**: Compare Meridian vs Tradier options
- **`GreeksDisplay`**: Binary option Greeks (delta, gamma, theta, vega)
- **`HistoricalOverlay`**: Historical return distribution overlay
- **`SettlementAnalytics`**: Settlement accuracy and calibration
- **`OptionsChainTable`**: Options chain comparison
- **`PriceHistory`**: Price history charts

#### Market Maker Components (`components/mm/`)
- **`QuoteTable`**: AMM bot quote display
- **`AggregateStats`**: Aggregate market maker statistics
- **`MintAndQuote`**: Mint pairs and place quotes

#### Admin Components (`components/admin/`)
- **`CreateMarketForm`**: Admin market creation
- **`MarketActions`**: Market management actions

#### Utility Components
- **`RedeemPanel`**: Token redemption interface
- **`SettlementStatus`**: Settlement status display
- **`SettleButton`**: Permissionless settlement trigger
- **`OraclePrice`**: Oracle price display
- **`WalletButton`**: Wallet connection button
- **`WatchlistStrip`**: Watchlist management
- **`ShareButtons`**: Social sharing
- **`InsightTooltip`**: Trading insights tooltips
- **`TransactionReceipt`**: Transaction receipt display
- **`TxToast`**: Transaction toast notifications
- **`FaucetButton`**: Devnet USDC faucet
- **`NetworkBadge`**: Network indicator
- **`NavBalance`**: Navigation balance display
- **`NavPnl`**: Navigation PnL display
- **`EventIndexerBanner`**: Event indexer status banner

### Frontend Libraries (`lib/`)

- **`pricer.ts`**: Black-Scholes pricing (ported from AMM bot)
- **`greeks.ts`**: Binary option Greeks calculations
- **`volatility.ts`**: Historical volatility calculations
- **`insights.ts`**: Trading insights and recommendations
- **`orderbook.ts`**: Order book parsing and utilities
- **`portfolioDb.ts`**: Portfolio database (IndexedDB) for local storage
- **`csv.ts`**: CSV export functionality
- **`share.ts`**: Social sharing utilities
- **`tradier-proxy.ts`**: Tradier API proxy client
- **`distribution-math.ts`**: Return distribution calculations
- **`eventParsers.ts`**: Event parsing utilities
- **`odds.ts`**: Odds calculation utilities
- **`social-proof.ts`**: Social proof features
- **`chartConfig.ts`**: Chart configuration
- **`strikes.ts`**: Strike calculation utilities
- **`tickers.ts`**: Ticker utilities
- **`pda.ts`**: PDA derivation helpers
- **`network.ts`**: Network utilities

### API Routes (`app/api/`)

- **`/api/tradier/quotes`**: Proxy Tradier quotes (60s TTL cache)
- **`/api/tradier/options`**: Options chain data
- **`/api/tradier/history`**: Historical price data
- **`/api/faucet/usdc`**: Devnet USDC faucet

### Transaction Flow

1. User submits order via `OrderForm`
2. Frontend composes v0 versioned transaction with ALT
3. Wallet signs transaction
4. Transaction sent to Solana (~400ms finality)
5. On-chain `place_order` instruction executes
6. `FillEvent` emitted (per fill)
7. Event Indexer parses logs → SQLite
8. Frontend queries REST API for updates

---

## 6. Data Flows

### Order Placement Flow

```
Frontend (OrderForm)
  ↓ compose v0 transaction with ALT
Wallet signs
  ↓ ~400ms finality
On-chain (place_order instruction)
  ↓ escrow assets
Matching engine runs
  ↓ fills + resting order
FillEvent emitted (per fill)
  ↓
Event Indexer parses logs
  ↓ writes to SQLite
Frontend queries REST API
```

### Settlement Flow

```
4:00 PM ET — Market closes
  ↓
Oracle Feeder updates PriceFeed
  ↓
4:05 PM ET — Settlement Service triggered
  ↓
Fetch Tradier closing prices
  ↓
Update oracle feeds
  ↓
Call settle_market (permissionless)
  ↓
SettlementEvent emitted
  ↓
Crank cancel resting orders
  ↓
Event Indexer indexes events
  ↓
Frontend shows settlement status
```

### Market Creation Flow

```
8:00 AM ET — Automation triggers
  ↓
Market Initializer runs
  ↓
Fetch Tradier previous close + volatility
  ↓
Calculate strikes (1σ, 1.5σ, 2σ)
  ↓
For each ticker/strike:
  - create_strike_market
  - allocate_order_book (13 incremental calls)
  - create ALT
  - set_market_alt
  ↓
AMM Bot seeds initial liquidity
```

### Frontend Data Fetching

```
React Component
  ↓
useMarkets() hook
  ↓
TanStack Query
  ↓
Anchor program.account.strikeMarket.all()
  ↓
RPC getProgramAccounts
  ↓
Deserialize accounts
  ↓
Component renders
  ↓
10s refetch interval
```

---

## 7. Position Constraints (On-Chain Enforcement)

### Implementation

Position constraints are **enforced on-chain** to prevent users from holding conflicting positions:

#### `mint_pair` Constraint
- Checks both Yes and No token balances must be zero
- Prevents minting pairs if user already holds tokens
- Error: `MeridianError::ConflictingPosition` (6059)

#### `place_order` Constraints
- **USDC Bid (side=0)**: User must have no No tokens
- **No Bid (side=2)**: User must have no Yes tokens
- Uses `reload()` to ensure fresh balances in composable transactions
- Error: `MeridianError::ConflictingPosition` (6059)

### Rationale

Prevents users from:
- Holding both Yes and No positions simultaneously (arbitrage risk)
- Creating synthetic positions that could complicate settlement
- Exploiting pricing inefficiencies through conflicting positions

### Technical Details

- Position checks happen **after** ATA initialization (if needed)
- Uses `reload()` pattern for composable transaction safety
- Checks are performed on-chain, not just frontend validation

---

## 8. Key Data Structures

### PDA Derivation Seeds

- **GlobalConfig**: `[b"config"]`
- **StrikeMarket**: `[b"market", ticker_bytes_8, strike_price_le_u64, expiry_day_le_u32]`
- **Yes Mint**: `[b"yes_mint", market.key()]`
- **No Mint**: `[b"no_mint", market.key()]`
- **OrderBook**: `[b"order_book", market.key()]`
- **PriceFeed**: `[b"price_feed", ticker_bytes_8]`

### Price Representation

- **On-chain**: `u8` (1-99 cents)
- **Frontend**: cents (1-99) or dollars (0.01-0.99)
- **Conversion**: `price_cents = prob * 100`, clamped to [1, 99]

### Token Model

1. **Minting**: `mint_pair` accepts $1 USDC → mints 1 Yes + 1 No token
2. **Trading**: Tokens trade on order book at prices 1-99 cents
3. **Settlement**: Oracle determines winner (YesWins=1, NoWins=2)
4. **Redemption**:
   - **Pair burn**: burn 1 Yes + 1 No → receive $1 (always available)
   - **Winner redeem**: burn winning tokens → receive $1 (after override window)
   - **Loser redeem**: burn losing tokens → receive $0

### Events

**FillEvent**:
- market, maker, taker, price, quantity, sides, is_merge, timestamp

**SettlementEvent**:
- market, ticker, strike_price, settlement_price, outcome, timestamp

**CrankCancelEvent**:
- market, cancelled_count

---

## 9. Key Design Decisions

### ZeroCopy Order Book
- **Why**: Avoids deserialization overhead on every access
- **Trade-off**: Fixed size (127KB) limits capacity but ensures predictable costs

### Three-Sided Order Book
- **Why**: Enables No-backed bids (merge/burn) for efficient pair redemption
- **Benefit**: Users can sell No tokens directly without minting pairs

### Incremental Order Book Allocation
- **Why**: Solana transaction size limits prevent single allocation
- **Solution**: 13 separate `allocate_order_book` calls

### Address Lookup Tables (ALTs)
- **Why**: Reduces transaction size for `place_order` (many accounts)
- **Benefit**: Enables more fills per transaction

### Permissionless Settlement
- **Why**: No single point of failure
- **Benefit**: Anyone can call `settle_market` after market close

### Black-Scholes Pricing (AMM Bot)
- **Why**: Standard binary option pricing model
- **Benefit**: Provides fair value quotes based on spot, strike, volatility, time

---

## 10. Service Dependencies

```
automation
  ├─→ market-initializer (8 AM)
  └─→ settlement (4 PM)

market-initializer
  ├─→ Tradier API (previous close, volatility)
  └─→ Solana (create markets)

oracle-feeder
  ├─→ Tradier WebSocket (real-time prices)
  └─→ Solana (update oracle)

amm-bot
  ├─→ Solana (read markets, place orders)
  └─→ Tradier API (optional: historical volatility)

settlement
  ├─→ Tradier API (closing prices)
  ├─→ Solana (update oracle, settle markets)
  └─→ Solana (crank cancel)

event-indexer
  └─→ Solana (listen to logs)

monitor
  └─→ Solana (read state)

frontend
  ├─→ Solana RPC (read accounts)
  ├─→ Event Indexer API (trade history)
  └─→ Tradier API (quotes, options)
```

---

## Summary

Meridian is a **sophisticated DeFi protocol** combining:
- **On-chain order book** with efficient ZeroCopy storage
- **Automated market making** with Black-Scholes pricing
- **Real-time price feeds** from Tradier
- **Automated settlement** at market close
- **Modern frontend** with wallet integration

The architecture emphasizes **decentralization** (permissionless settlement), **efficiency** (ZeroCopy, ALTs), and **automation** (AMM bot, scheduled services).
