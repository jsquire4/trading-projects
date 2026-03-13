# Meridian — Architecture Overview

Binary stock outcome trading on Solana. Users bet whether a stock closes above or below a strike price by market close. $1 in, $1 out — winner takes all.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SOLANA BLOCKCHAIN                            │
│                                                                         │
│  ┌──────────────────────┐          ┌──────────────────────┐            │
│  │   Meridian Program   │          │  Mock Oracle Program  │            │
│  │                      │          │                       │            │
│  │  GlobalConfig        │          │  PriceFeed (per tick) │            │
│  │  StrikeMarket (×N)   │◄─────── │  price, confidence,   │            │
│  │  OrderBook (×N)      │  reads   │  timestamp, authority │            │
│  │  Yes/No Mints        │          └───────────▲───────────┘            │
│  │  USDC Vault/Escrows  │                      │                        │
│  │  Treasury, Fee Vault │                      │ update_price            │
│  └──────────▲───────────┘                      │                        │
└─────────────┼──────────────────────────────────┼────────────────────────┘
              │                                  │
              │ place_order, cancel_order,        │
              │ mint_pair, settle, redeem, ...    │
              │                                  │
┌─────────────┼──────────────────────────────────┼────────────────────────┐
│             │          SERVICES LAYER           │                        │
│  ┌──────────┴──────────┐  ┌────────────────────┴───┐  ┌──────────────┐ │
│  │      AMM Bot        │  │    Oracle Feeder        │  │  Automation  │ │
│  │  price → quote →    │  │  Tradier WS → on-chain  │  │  Scheduler   │ │
│  │  place two-sided    │  │  5s rate limit/ticker    │  │  08:00 init  │ │
│  │  orders (30s loop)  │  └─────────────────────────┘  │  16:05 settle│ │
│  └─────────────────────┘                                └──────────────┘ │
│  ┌─────────────────────┐  ┌─────────────────────────┐  ┌──────────────┐ │
│  │  Market Initializer  │  │    Event Indexer         │  │   Monitor    │ │
│  │  strikes from vol +  │  │  logs → SQLite → REST   │  │  SOL balance │ │
│  │  prev close → create │  │  backfill + live listen  │  │  oracle stale│ │
│  │  markets daily 08:00 │  │  fills, settlements      │  │  5min checks │ │
│  └─────────────────────┘  └────────────┬────────────┘  └──────────────┘ │
│  ┌─────────────────────┐               │                                 │
│  │    Settlement        │               │  REST API (:3001)              │
│  │  16:05 ET settle +   │               │                                │
│  │  crank + redeem      │               │                                │
│  └─────────────────────┘               │                                 │
└─────────────────────────────────────────┼───────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────┐
              │          FRONTEND          │    (Next.js 14)       │
              │                           ▼                       │
              │  ┌─────────┐  ┌──────────────────┐  ┌─────────┐ │
              │  │  Trade   │  │  Portfolio / P&L  │  │Analytics│ │
              │  │  Hub     │  │  Positions, Orders│  │ Greeks  │ │
              │  │  OrderBook│  │  Fill History     │  │ Options │ │
              │  │  OrderForm│  │  Cost Basis       │  │ Chain   │ │
              │  └─────────┘  └──────────────────┘  └─────────┘ │
              │       │                                    │      │
              │       ▼                                    ▼      │
              │  Solana RPC (wallet adapter)     Tradier API      │
              │  + Event Indexer REST API         (proxied)       │
              └──────────────────────────────────────────────────┘
```

---

## On-Chain Programs

### Meridian Program

The core trading program. Two Solana programs deployed from a single Anchor workspace:

- **meridian** (`7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth`) — trading, settlement, redemption
- **mock_oracle** (`HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ`) — price feeds, swappable for Pyth on mainnet

#### Account Model

**GlobalConfig** (singleton, PDA `[b"config"]`)
- Admin authority, USDC mint address, oracle program reference
- 7 tickers (MAG7: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA)
- Staleness thresholds: 60s for trading, 120s for settlement
- Oracle confidence band: 50 bps (0.5%)
- Protocol fee: configurable up to 10% (applied per-side on fills)
- Owns: Treasury (USDC) and Fee Vault (USDC) token accounts

**StrikeMarket** (per market, PDA `[b"market", ticker, strike_le, expiry_day_le]`)
- Defines one binary outcome: "Will {ticker} close at or above ${strike} by {close_time}?"
- References: config, yes_mint, no_mint, usdc_vault, escrow_vault, yes_escrow, no_escrow, order_book, oracle_feed
- State: strike_price, total_minted, total_redeemed, settlement_price, outcome (Yes=1, No=2), flags (settled, paused, closed)
- Override system: up to 3 admin corrections within expanding time windows post-settlement

**OrderBook** (per market, PDA `[b"order_book", market_key]`, ZeroCopy)
- 254 KB account, pre-allocated incrementally (13 × 10 KB allocs) due to Solana's CPI size limit
- 99 price levels (1–99 cents), 32 order slots per level
- Holey layout: cancelled slots stay in place (is_active=0), not compacted
- Each slot: owner, order_id, quantity, original_quantity, side, timestamp, is_active
- Global monotonic order counter (next_order_id)

**Token Accounts** (per market, all authority = market PDA):

| Account | PDA Seed | Holds |
|---------|----------|-------|
| usdc_vault | `[b"vault", market]` | $1 USDC per minted pair (collateral pool) |
| escrow_vault | `[b"escrow", market]` | USDC from bid orders (locked until fill/cancel) |
| yes_escrow | `[b"yes_escrow", market]` | Yes tokens from sell orders |
| no_escrow | `[b"no_escrow", market]` | No tokens from No-bid orders |
| yes_mint | `[b"yes_mint", market]` | Yes outcome token (6 decimals) |
| no_mint | `[b"no_mint", market]` | No outcome token (6 decimals) |

#### Instructions (19 total)

**Setup & Admin:**
- `initialize_config` — One-time: creates GlobalConfig with admin, USDC mint, oracle program, tickers, thresholds, fees
- `create_strike_market` — Creates market with all associated accounts (mints, vaults, escrows, order book)
- `set_market_alt` — Attaches Address Lookup Table to market (post-creation optimization for tx size)
- `allocate_order_book` — Incremental 10 KB allocs to build the 254 KB order book account
- `pause` / `unpause` — Global or per-market trading halt
- `update_fee_bps` — Adjust protocol fee (max 10%)
- `update_strike_creation_fee` — Fee for non-admin market creators

**Trading:**
- `mint_pair` — Deposit $1 USDC → receive 1 Yes + 1 No token (synthetic pair)
- `place_order` — Place limit or market order with on-chain matching
- `cancel_order` — Cancel resting order, refund escrowed assets

**Settlement & Redemption:**
- `settle_market` — Permissionless: reads oracle price at close, determines Yes/No winner
- `admin_settle` — Fallback: admin force-settles after 1-hour delay from close time
- `admin_override_settlement` — Correct settlement price (up to 3 times within override window)
- `redeem` — Burn winning tokens (or pair-burn anytime) → receive USDC
- `crank_cancel` — Permissionless batch cancellation of resting orders on settled markets
- `crank_redeem` — Permissionless auto-redemption for delegated accounts
- `close_market` — Admin closes market accounts (90-day grace period for partial close)
- `cleanup_market` — Final account reclamation when all tokens redeemed
- `treasury_redeem` — Redeem tokens from treasury for closed markets

### Mock Oracle Program

Simple price feed that the meridian program reads during settlement and that the oracle-feeder service writes to.

**PriceFeed** (per ticker, PDA `[b"price_feed", ticker]`)
- Fields: ticker, price (USDC lamports), confidence, timestamp, authority, is_initialized
- Two instructions: `initialize_feed` (create), `update_price` (authority writes new price)
- Validated by meridian: discriminator check, staleness check, confidence band check

Designed to be swapped for Pyth on mainnet — the meridian program references `oracle_program` in GlobalConfig and validates the feed's program owner.

---

## The Order Book

### Structure

The order book is the central trading mechanism. Each market has one order book with 99 price levels (1¢ to 99¢) representing the implied probability of the outcome.

A price of 65¢ on the Yes side means: "I believe there's a 65% chance the stock closes above the strike." The complementary No price is always 100 - Yes price = 35¢.

```
Price Level 99:  [slot0] [slot1] ... [slot31]    ← 32 order slots per level
Price Level 98:  [slot0] [slot1] ... [slot31]
  ...
Price Level  1:  [slot0] [slot1] ... [slot31]

Each slot (80 bytes):
  owner (32B) | order_id (8B) | quantity (8B) | original_qty (8B)
  side (1B) | timestamp (8B) | is_active (1B) | padding (14B)
```

Total: 99 levels × 32 slots × 80 bytes = ~253 KB + header = 254,280 bytes.

### Three Order Sides

The order book supports three logical sides that coexist on the same price levels:

| Side | Code | What it means | What gets escrowed |
|------|------|---------------|--------------------|
| USDC Bid | 0 | "Buy Yes at this price" | USDC (ceil(qty × price / 100)) |
| Yes Ask | 1 | "Sell Yes at this price" | Yes tokens |
| No Bid | 2 | "Buy No at (100 - price)" | No tokens |

The No Bid side is the key insight: instead of a separate No order book, No bids sit on the Yes price ladder at the complementary price. A No bid at 35¢ appears at Yes price level 65 (since 100 - 35 = 65).

### Matching Engine

Orders match via price-time priority (FIFO within each level):

**Standard swap** (USDC Bid × Yes Ask):
- Match when bid_price ≥ ask_price
- USDC flows from bidder's escrow to seller (minus fee)
- Yes tokens flow from seller's escrow to bidder
- Price improvement refunded if filled at better price than limit

**Merge/burn** (No Bid × Yes Ask):
- Match when yes_price + no_price ≤ 100 (i.e., (100 - no_bid_price) ≥ ask_price)
- Both Yes and No tokens are burned (merged back into the $1 they represent)
- USDC distributed from vault: (100 - price)/100 to Yes seller, price/100 to No seller
- Fees apply to both sides

The engine walks price levels from best to worst, scanning all 32 slots per level (holey layout means inactive slots are skipped, not removed). Maximum 32 fills per order.

### Holey Layout

When an order is cancelled, its slot is marked `is_active = 0` but not compacted. This means:
- **O(1) cancellation** — no array shifting needed
- **Scanner must check all 32 slots** per level during matching
- New orders fill the first inactive slot found

### Fee Mechanics

- Fee = floor(gross_amount × fee_bps / 10,000)
- Applied to both maker and taker sides of every fill
- Collected in the protocol's Fee Vault
- Escrow dust from ceiling/floor division asymmetry swept to treasury on market close

---

## Token Economics

### The $1 Invariant

Every market maintains a strict invariant: **1 Yes token + 1 No token = $1 USDC**.

This is enforced at every level:

1. **Minting**: User deposits $1 USDC → receives 1 Yes + 1 No. Vault balance increases by $1.
2. **Pair burn**: User returns 1 Yes + 1 No → receives $1 USDC. Available anytime, even before settlement.
3. **Winner redemption**: After settlement, 1 winning token → $1 USDC.
4. **Ring-fencing**: Pair burns cannot reduce vault below the outstanding winning token supply, ensuring solvency.

### Price Discovery

Prices represent implied probabilities. If Yes trades at 70¢:
- Buyer pays 70¢, wins $1 if correct (43% return)
- Seller receives 70¢, keeps it if stock closes below strike
- No token simultaneously worth 30¢ (100 - 70)

### Example Trade Flow

Alice thinks AAPL will close above $200. Bob disagrees.

```
1. Alice mints a pair:  $1 USDC → 1 Yes + 1 No
2. Alice sells her No:  Places Yes Ask at 65¢ (willing to sell No at 35¢)
3. Bob buys No:         Places USDC Bid at 35¢ for No (appears as No Bid at level 65)
   → Engine matches:    Bob's USDC → Alice, Alice's No → Bob
4. At close: AAPL = $205 (above $200 strike) → Yes wins
5. Alice redeems:       Burns 1 Yes → receives $1 USDC
   Alice's P&L:         Spent $1 minting, received 35¢ selling No + $1 redeeming Yes = +35¢
   Bob's P&L:           Spent 35¢, No token worthless = -35¢
```

---

## Data Flows

### Market Lifecycle

```
08:00 ET                           Trading Day                        16:00 ET     16:05 ET
   │                                                                      │            │
   ▼                                                                      ▼            ▼
┌──────────┐    ┌──────────────────────────────────────────────┐    ┌──────────┐  ┌─────────┐
│  Market   │    │                  TRADING                     │    │  Market  │  │  Settle │
│  Init     │───▶│  mint_pair, place_order, cancel_order        │───▶│  Closes  │─▶│  Market │
│  Service  │    │  AMM bot provides continuous liquidity       │    │  (no new │  │  (oracle│
│  creates  │    │  Oracle feeder streams prices every 5s       │    │  orders) │  │  price) │
│  markets  │    │  Event indexer records all fills              │    └──────────┘  └────┬────┘
└──────────┘    └──────────────────────────────────────────────┘                        │
                                                                                        ▼
                                                                              ┌──────────────────┐
                                                                              │  Post-Settlement  │
                                                                              │  crank_cancel     │
                                                                              │  crank_redeem     │
                                                                              │  redeem (manual)  │
                                                                              │  close (90 days)  │
                                                                              └──────────────────┘
```

### Oracle Price Flow

```
Tradier WebSocket ──▶ Oracle Feeder ──▶ update_price (on-chain) ──▶ PriceFeed PDA
     │                  (5s/ticker)              │
     │                                           ▼
     │                               StrikeMarket reads at:
     │                               • Order placement (staleness ≤60s)
     └── REST fallback (30s poll) ── • Settlement (staleness ≤120s)
```

The oracle feeder connects to Tradier's WebSocket stream for real-time trade prices. Rate-limited to one on-chain update per ticker per 5 seconds. Falls back to REST polling every 30 seconds if the WebSocket goes idle. Reconnects with exponential backoff (1s → 60s cap).

### Event Indexing Flow

```
Solana Program Logs ──▶ Event Indexer ──▶ SQLite ──▶ REST API (:3001)
                         │                              │
                         ├── Live: onLogs subscription   ├── /api/events
                         └── Backfill: walk tx history   ├── /api/fills?wallet=
                              with checkpointing         ├── /api/cost-basis?wallet=
                                                         ├── /api/portfolio?wallet=
                                                         ├── /api/portfolio-history?wallet=
                                                         └── /api/market-vwaps
```

The indexer subscribes to program logs in real-time and also backfills from the last checkpoint on startup. Events are deduplicated by (signature, type, market, seq). The frontend queries this REST API for fill history, cost basis, portfolio snapshots, and P&L history.

An `order-intent` endpoint lets the frontend label orders at submission time ("buy_yes", "sell_yes", "buy_no", "sell_no") so that fills can be displayed from the user's perspective — important because "Buy No" is a UI-level concept that maps to different on-chain sides depending on execution path.

### AMM Bot Pricing Flow

```
Market Data (Tradier/Synthetic)
     │
     ▼
Historical Volatility (30-day log returns, per ticker)
     │
     ▼
Black-Scholes Binary Call: P = e^(-rT) × N(d2)
     │
     ▼
Fair Value → Bid/Ask with inventory skew
     │   spread = spreadBps (default 5%)
     │   skew = inventory × skewFactor × spread
     │   bid = fair - halfSpread + skew
     │   ask = fair + halfSpread + skew
     ▼
Circuit Breaker check (inventory > max OR errors > 5)
     │
     ▼
Executor: cancel old orders → place bid + ask (atomic pair)
     └── If ask fails, cancel orphaned bid (avoid one-sided exposure)
```

The AMM bot runs a 30-second loop. For each active, unsettled market it:
1. Reads the oracle price and time to expiry
2. Fetches per-ticker historical volatility from Tradier (or uses BOT_VOL fallback)
3. Computes fair value using Black-Scholes N(d2) pricing for binary options
4. Generates a two-sided quote with inventory-aware skew (positive inventory → lower prices to encourage selling)
5. Cancels all existing bot orders, then places new bid + ask

---

## Frontend

Next.js 14 application with React 18, Tailwind CSS, TanStack Query, Recharts, and Solana wallet adapter.

### Pages

| Route | Purpose |
|-------|---------|
| `/` | Landing page — hero, how-it-works, live market summary, platform stats |
| `/trade` | Market hub — all active markets, ticker filtering, watchlist, countdown urgency |
| `/trade/[ticker]` | Per-ticker cockpit — order book, order form, positions, fills, settlement status |
| `/portfolio` | Portfolio dashboard — 4 tabs: Performance (P&L chart), Positions, Orders, History |
| `/history` | Trade history — paginated fill log from event indexer |
| `/analytics` | Advanced analytics — Greeks, options chain comparison, price history, distribution |
| `/admin` | Admin panel — create markets, settle, pause, override |

### Key Components

**Trading:**
- `OrderForm` — Side selector (Buy/Sell Yes/No), limit/market toggle, price + dollar amount inputs. "Buy No" is a compound transaction: mint pair → sell Yes → optional pair burn.
- `OrderBook` — Dual-perspective display (Yes view / No view toggle), table or depth chart. Clicking a price populates the order form.
- `MyOrders` / `MyPositions` — Active orders and token holdings for current market.
- `RedeemPanel` — Post-settlement: pair-burn or winner redemption mode.

**Portfolio:**
- `PnlTab` — Intraday P&L area chart, daily summaries, top/bottom performers.
- `PositionsTab` — Aggregated positions across all markets with cost basis and unrealized P&L.
- `OpenOrdersTab` — All active orders across markets with cancel.
- `TradeHistoryTab` — Paginated fill history from event indexer with CSV export.

**Analytics:**
- `OptionsComparison` — Binary market delta vs. Black-Scholes theoretical delta.
- `GreeksDisplay` — Delta, gamma, theta, vega for binary options.
- `PriceHistory` — OHLCV chart from Tradier API.
- `HistoricalOverlay` — Price distribution analysis.

### Data Fetching

TanStack Query manages all data with automatic deduplication, caching, and background refetching:

| Data | Stale Time | Refetch Interval | Source |
|------|-----------|-------------------|--------|
| Markets | 5s | 10s | Solana RPC (account fetch) |
| Order books | 2.5s | 5s | Solana RPC (account fetch) |
| Positions | 3s | 5s | Solana RPC (token accounts) |
| Wallet balance | real-time | WebSocket (fallback: 10s poll) | Solana RPC |
| Fill history | on-demand | — | Event Indexer REST |
| Cost basis | on-demand | — | Event Indexer REST |
| Tradier quotes | 60s cache | — | `/api/tradier/*` proxy routes |

The order book deserializer is a hand-rolled DataView parser that reads the 254 KB ZeroCopy account, extracting active orders from the holey layout and aggregating them into Yes/No perspectives with spread calculation.

### Wallet Integration

Standard Solana wallet adapter (Phantom, Solflare). WebSocket subscription tracks SOL + USDC balances in real-time with exponential backoff fallback to polling.

### API Routes

- `/api/faucet/usdc` — Devnet USDC minting (rate-limited: 60s per wallet)
- `/api/tradier/quotes` — Proxied stock quotes (server-side cache + rate limit)
- `/api/tradier/history` — Proxied OHLCV history
- `/api/tradier/options` — Proxied options chain
- `/api/tradier/expirations` — Proxied option expiration dates

All Tradier routes use a server-side token-bucket rate limiter (60 req/min) and 60-second TTL cache.

---

## Services

### Oracle Feeder
Streams real-time stock prices from Tradier to on-chain PriceFeed accounts. WebSocket primary, REST fallback. Rate-limited to 1 update per ticker per 5 seconds. Reconnects with exponential backoff.

### AMM Bot
Automated market maker providing continuous two-sided liquidity. Black-Scholes N(d2) pricing with inventory-aware skew. Circuit breaker halts quoting if inventory exceeds max or consecutive errors exceed 5. Cancels all orders before re-quoting to avoid stale exposure.

### Event Indexer
Listens to Solana program logs, parses Anchor events (fills, settlements, crank cancels), stores in SQLite (WAL mode), and serves via REST API. Backfills from checkpoint on restart. Deduplicates by (signature, type, market, seq).

### Market Initializer
Creates markets daily at 08:00 ET. Fetches previous close from Tradier, computes volatility-aware strikes at ±3%, ±6%, ±9%, and creates on-chain markets with all associated accounts. Idempotent — skips existing markets.

### Settlement Service
Runs at 16:05 ET. Updates oracle feeds with closing prices, settles expired markets, cranks order cancellation, auto-redeems winning tokens for delegated accounts, and closes eligible markets (90+ days post-settlement).

### Automation Scheduler
Long-running coordinator that triggers market initialization (08:00 ET), verification (08:30), settlement (16:05), and settlement verification (16:10). DST-aware scheduling, reschedules at midnight ET. Prevents duplicate runs.

### Monitor
Health check daemon on 5-minute interval. Alerts on: low admin SOL balance (<0.1), stale oracle feeds during market hours, unsettled expired markets, closeable markets.

### Shared Library (`services/shared/src/`)
Common utilities imported by all services and the frontend (via `@shared/*` path alias):

- `pda.ts` — PDA derivation for all program accounts
- `strikes.ts` — Strike price generation (±3/6/9% from previous close, vol-adjusted)
- `pricer.ts` — Black-Scholes binary call pricing: P = e^(-rT) × N(d2)
- `greeks.ts` — Binary option delta, gamma, theta, vega
- `volatility.ts` — Historical volatility from close-to-close log returns (30-day, annualized)
- `quoter.ts` — Two-sided quote generation with inventory skew and circuit breaker
- `tradier-client.ts` — Tradier REST/WebSocket client with token-bucket rate limiting
- `market-data.ts` — Factory: returns TradierClient (live) or SyntheticClient based on env
- `synthetic-client.ts` — Deterministic GBM price generator for dev/test (no API key needed)
- `alerting.ts` — Structured logger with optional webhook dispatch

---

## Deployment & Infrastructure

### Build

- **Rust programs**: `anchor build` → compiles .so binaries + generates IDL/types
- **Frontend**: `next build` in `app/meridian-web/`
- **Services**: Runtime TypeScript via `tsx` (no compile step)

### Environments

| Environment | RPC | Oracle | Market Data |
|-------------|-----|--------|-------------|
| Localnet | localhost:8899 | mock_oracle (synthetic) | SyntheticClient |
| Devnet | api.devnet.solana.com | mock_oracle (Tradier) | TradierClient |
| Mainnet | (future) | Pyth | TradierClient |

### CI/CD

GitHub Actions on push/PR to main, three parallel jobs:
1. **anchor-tests** — Build programs + run bankrun tests (Rust 1.94.0, Solana 2.1.21, Anchor 0.31.1)
2. **frontend-tests** — TypeScript check + Vitest
3. **service-tests** — Vitest for amm-bot, market-initializer, event-indexer

### Scripts

| Script | Purpose |
|--------|---------|
| `deploy-devnet.sh` | Idempotent 8-step devnet deploy (build → deploy → init state → create markets) |
| `local-stack.sh` | Full local stack (validator → init → services → frontend) |
| `stress-test.ts` | 6-phase load test (fund → mint → create → trade → settle → verify) |
| `validate-stack.ts` | Smoke test (check programs, accounts, oracle freshness) |

### Monorepo Structure

```
peak6/
├── programs/              # Rust/Anchor (Cargo workspace)
│   ├── meridian/          # Main program (18 instructions)
│   └── mock-oracle/       # Oracle program (2 instructions)
├── app/meridian-web/      # Next.js 14 frontend
├── services/              # Node.js microservices
│   ├── shared/            # Common library
│   ├── oracle-feeder/
│   ├── amm-bot/
│   ├── event-indexer/
│   ├── market-initializer/
│   ├── settlement/
│   ├── automation/
│   └── monitor/
├── tests/                 # On-chain bankrun tests
├── scripts/               # Deploy, init, stress test
├── target/                # Build artifacts (.so, IDL, types)
└── Makefile               # Dev targets (install, dev, services, test)
```

IDL files are copied to `app/meridian-web/src/idl/` and `services/shared/src/idl/` for type-safe program interaction from TypeScript.

---

## Test Suite

482 tests across 5 domains:

| Domain | Count | Framework | What's Tested |
|--------|-------|-----------|---------------|
| On-chain | 91 | Anchor + bankrun | All 19 instructions, matching engine, edge cases, error codes |
| Frontend | 242 | Vitest + React Testing Library | Components, hooks, libs, order flow, analytics |
| AMM Bot | 75 | Vitest | Pricer, quoter, executor, circuit breaker, inventory skew |
| Event Indexer | 55 | Vitest | Listener parsing, backfill, REST endpoints, cost basis |
| Market Init | 19 | Vitest | Strike generation, market creation, idempotency |

Key: on-chain tests use bankrun (in-process Solana runtime) with `SBF_OUT_DIR` pointing to compiled .so files. No validator needed.
