# Meridian — Implementation Plan

## Context

Building a binary stock outcome trading platform on Solana as a Peak6 assignment. Users trade Yes/No tokens on whether MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) close above a strike price today. Contracts are 0DTE, settle at 4 PM ET via Tradier API data, pay $1 USDC to winners. The goal is a working devnet prototype that meets all spec requirements plus 6 differentiator features.

Full spec: `/Users/js/dev/peak6/docs/Meridian - Binary Stock Outcome Markets on Blockchain.md`
Order book specification: `/Users/js/dev/peak6/docs/ORDER_BOOK.md`
Decision log: `/Users/js/dev/peak6/docs/DEV_LOG.md`

## Locked Decisions

- **Chain**: Solana devnet (Anchor 0.30.x)
- **Order book**: Custom built-in (not Phoenix) — full control, simpler atomic Buy No
- **Oracle**: Mock oracle program fed by Tradier brokerage API (real MAG7 stock data)
- **Frontend**: Next.js 14/15 + wallet adapter + TanStack Query + Tailwind
- **Token model**: SPL mint-pair (1 USDC = 1 Yes + 1 No)

---

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Token program | SPL Token (not Token-2022) | Simpler, better tooling, transfer restrictions not needed for prototype |
| Token decimals | 6 for Yes, No, and mock USDC | Matches USDC precision, simplifies 1:1 arithmetic (1 pair = 1_000_000 lamports) |
| Freeze authority | Market PDA holds freeze authority on Yes/No mints | `pause` can freeze both mints, blocking all token movement |
| Mint authority | Market PDA is sole mint authority | Tokens only created via `mint_pair` instruction |
| Escrow model | **Separate escrow vault** per market | PDA: `[b"escrow", market.key]`. Holds USDC bids + Yes token asks. Main vault holds only mint collateral. Preserves invariant: main vault = $1 × pairs minted. |
| Staleness thresholds | Two-tier: 60s general, 120s settlement | General (trading display): 60s per Pyth/Drift Solana DeFi standard. Settlement: 120s — closing price is written once post-4PM, more buffer needed for tx confirmation. Both configurable in GlobalConfig. |
| Confidence threshold | 0.5% of price | Validation formula: `oracle.confidence <= oracle.price * confidence_bps / 10_000`. For a $200 stock with `confidence_bps = 50`, band must be < $1.00. Stock closing prices are precise; anything wider indicates bad data. Configurable in GlobalConfig. |
| Order IDs | Global u64 counter in OrderBook account | `next_order_id` increments on each placement. Cancel by `(price_level, order_id)` tuple. |
| Price representation | u8 in range [1, 99] | Price 50 = $0.50. Market buy sends price=99 (take any ask). Market sell sends price=1 (take any bid). Fill when bid >= ask. Execution at resting order's price. |
| Settlement operator | `>=` (at-or-above) | Price >= strike → Yes wins. Anyone can call `settle_market` (deterministic oracle read). |
| Post-settlement order cleanup | `crank_cancel` instruction | `settle_market` sets `is_settled=true`. Permissionless `crank_cancel` iterates up to N slots per call, returns escrow to owners. Settlement service cranks in a loop until book is empty. Manual `cancel_order` still works alongside. |
| Self-trade prevention | Allow (prototype) | Documented as known limitation. No economic harm, just wasteful. |
| Position constraints | Frontend-only (not on-chain) | Standard SPL tokens are transferable. A user could transfer No tokens to wallet B, Buy Yes from wallet A. Documented limitation. |
| Overflow protection | `overflow-checks = true` in `[profile.release]` Cargo.toml | All arithmetic checked at compile time. Small CU cost, major safety gain. |
| Pause scope | Both global and per-market | `is_paused` on GlobalConfig (global) + `is_paused` on StrikeMarket (per-market). Instructions check both. |
| `add_strike` | Folded into `create_strike_market` (spec enhancement) | No separate instruction needed — `create_strike_market` is admin-only and callable anytime (morning or intraday). PDA seeds (`[b"market", ticker, strike, expiry_day]`) guarantee deduplication — duplicate calls fail with `AccountAlreadyInUse`. See DEV_LOG "Spec Deviations" for rationale. See "Smart Contract Instructions" section for the full 15-instruction breakdown. |
| Package manager | Yarn | Consistent with Anchor ecosystem defaults |
| Anchor version | `anchor-lang = "0.30.1"` (pinned) | Exact version avoids breaking changes between patch releases |
| Service runtime | npm scripts, `Makefile` for orchestration | `make services` starts oracle-feeder + amm-bot + market-initializer + event-indexer. No Docker/pm2 for prototype. |
| Admin keypair | `~/.config/solana/id.json` (Solana CLI default) | Same keypair = deployer, admin, oracle authority for devnet. **Faucet uses a separate dedicated keypair** (USDC mint authority only — cannot deploy or act as admin). Document in README. |
| Program upgrade authority | Upgradeable on devnet, deployer holds authority | Solana default — programs are upgradeable via BPF Loader Upgradeable. Allows iteration without redeploying to new program IDs (preserves all existing PDAs/accounts). Mainnet: transfer authority to multisig or revoke with `--final` flag once stable. |
| Transaction format | v0 versioned transactions + per-market ALTs | Every market gets an ALT at creation time, pre-loaded with all market PDAs + programs. 1-byte index vs 32-byte key per account. No legacy tx path. All major wallets support v0. |
| Devnet RPC | Default `https://api.devnet.solana.com` | Zero-config. Helius documented as recommended upgrade. `SOLANA_RPC_URL` in `.env.example`. |

---

## PDA Registry

Every PDA in the system with exact seeds. Rust and TypeScript must match byte-for-byte.

| Account | Seeds | Bump | Notes |
|---|---|---|---|
| GlobalConfig | `[b"config"]` | stored | One per program deployment |
| StrikeMarket | `[b"market", ticker_bytes, strike_price_le_bytes, expiry_day_le_bytes]` | stored | `ticker_bytes`: UTF-8 padded to 8 bytes. `strike_price`: u64 LE (USDC lamports, e.g. 680_000_000 for $680). `expiry_day`: u32 LE = `floor(market_close_unix / 86400)`. |
| Yes Mint | `[b"yes_mint", market.key().as_ref()]` | stored | Authority = market PDA. Freeze authority = market PDA. Decimals = 6. |
| No Mint | `[b"no_mint", market.key().as_ref()]` | stored | Same authorities. |
| USDC Vault | `[b"vault", market.key().as_ref()]` | stored | Token account owned by market PDA. Holds mint collateral only. |
| Escrow Vault | `[b"escrow", market.key().as_ref()]` | stored | Token account (USDC) owned by market PDA. Holds bid escrow. |
| Yes Escrow | `[b"yes_escrow", market.key().as_ref()]` | stored | Token account (Yes) owned by market PDA. Holds ask escrow (Sell Yes limit orders). |
| No Escrow | `[b"no_escrow", market.key().as_ref()]` | stored | Token account (No) owned by market PDA. Holds No-backed bid escrow (Sell No limit orders). |
| OrderBook | `[b"order_book", market.key().as_ref()]` | stored | ZeroCopy account. One per market. |
| PriceFeed | `[b"price_feed", ticker_bytes]` | stored | Mock oracle. `ticker_bytes` same encoding as StrikeMarket. |
| Treasury | `[b"treasury"]` | stored | USDC token account owned by GlobalConfig PDA. Created during `initialize_config`. Receives unclaimed USDC from force-closed markets (Phase 6). |

**TypeScript derivation**: `PublicKey.findProgramAddressSync([Buffer.from("market"), tickerBuffer, strikePriceBuffer, expiryDayBuffer], programId)` — `tickerBuffer` is UTF-8 padded to 8 bytes with zeros, `strikePriceBuffer` is `Buffer.alloc(8)` with `writeBigUInt64LE`, `expiryDayBuffer` is `Buffer.alloc(4)` with `writeUInt32LE`.

---

## Account Schemas

### GlobalConfig (184 bytes + 8 discriminator = 192 bytes on-chain)
```
admin: Pubkey              // 32 — admin authority
usdc_mint: Pubkey          // 32 — mock USDC mint on devnet
oracle_program: Pubkey     // 32 — mock oracle program ID
staleness_threshold: u64   // 8  — max oracle age for general ops (default 60s, per Pyth/Drift standard)
settlement_staleness: u64  // 8  — max oracle age for settlement (default 120s, closing price is written once)
confidence_bps: u64        // 8  — max confidence band as basis points of price (default 50 = 0.5%)
is_paused: bool            // 1  — global pause flag
oracle_type: u8            // 1  — 0=Mock, 1=Pyth. Set at init, used by settle_market to branch deserialization.
tickers: [[u8; 8]; 7]     // 56 — 7 supported tickers, padded
ticker_count: u8           // 1  — number of active tickers
bump: u8                   // 1  — PDA bump
_padding: [u8; 4]          // 4  — alignment (was 5, oracle_type took 1)
```
Field sum: 3×32 (Pubkeys) + 3×8 (u64s) + 56 (tickers) + 4×1 (bool/u8) + 4 (padding) = 96+24+56+4+4 = 184 bytes data + 8 discriminator = 192 bytes on-chain. Note: Anchor `repr(C)` may insert alignment padding between small fields and subsequent u64/Pubkey fields — verify with `std::mem::size_of::<GlobalConfig>()` after implementation.

### StrikeMarket (estimated ~382 bytes + 8 discriminator — verify with `std::mem::size_of`)

**Recommended field order** — groups by alignment to eliminate implicit `repr(C)` padding:
```
// — 32-byte aligned (Pubkeys) —
config: Pubkey             // 32 — parent GlobalConfig
yes_mint: Pubkey           // 32
no_mint: Pubkey            // 32
usdc_vault: Pubkey         // 32 — collateral vault
escrow_vault: Pubkey       // 32 — bid escrow (USDC)
yes_escrow: Pubkey         // 32 — ask escrow (Yes tokens, Sell Yes limits)
no_escrow: Pubkey          // 32 — No-backed bid escrow (No tokens, Sell No limits)
order_book: Pubkey         // 32 — OrderBook account
oracle_feed: Pubkey        // 32 — PriceFeed to read at settlement

// — 8-byte aligned (u64/i64) —
strike_price: u64          // 8  — in USDC lamports (680_000_000 = $680.00)
market_close_unix: i64     // 8  — UTC timestamp for 4 PM ET on this trading day
total_minted: u64          // 8  — total pairs minted (in token lamports)
total_redeemed: u64        // 8  — total pairs redeemed
settlement_price: u64      // 8  — oracle price at settlement (0 if unsettled)
previous_close: u64        // 8  — reference price for display
settled_at: i64            // 8  — settlement timestamp (0 if unsettled)
override_deadline: i64     // 8  — settled_at + 3600; admin can override until this time. 0 if unsettled.

// — 32-byte aligned (continued) —
alt_address: Pubkey        // 32 — Address Lookup Table for this market (set post-creation via set_market_alt)

// — 1-byte aligned (u8/bool/byte arrays) —
ticker: [u8; 8]            // 8  — stock ticker (UTF-8, zero-padded)
is_settled: bool           // 1
outcome: u8                // 1  — 0=unsettled, 1=YesWins, 2=NoWins
is_paused: bool            // 1  — per-market pause
is_closed: bool            // 1  — true after partial close_market (Phase 6). Vault swept to treasury, OrderBook closed.
override_count: u8         // 1  — number of overrides used (max 3). Prevents indefinite limbo.
bump: u8                   // 1
_padding: [u8; 2]          // 2  — align to 8-byte boundary
```
Field sum (with alignment-optimized order, zero implicit padding): 10×32 + 8×8 + 8 + 6×1 + 2 = 320 + 64 + 8 + 6 + 2 = **400 bytes** data + 8 discriminator = **408 bytes** on-chain. **Lock the exact size with `std::mem::size_of::<StrikeMarket>()` in Phase 1A** — if Anchor's `#[account]` macro or zero-copy derivation reorders or pads fields differently, the `space` value must match the actual compiled size.

### OrderBook (ZeroCopy, ~116 KB estimated — verify with `std::mem::size_of`)
```
market: Pubkey             // 32
next_order_id: u64         // 8  — monotonically incrementing
levels: [PriceLevel; 99]   // 99 price levels (index 0 = price 1, index 98 = price 99)
bump: u8                   // 1
```

Each `PriceLevel`:
```
orders: [OrderSlot; 16]    // 16 slots per level
count: u8                  // active orders at this level
```

Each `OrderSlot` (73 bytes):
```
owner: Pubkey              // 32 — order placer
order_id: u64              // 8  — unique ID from next_order_id
quantity: u64              // 8  — remaining quantity (token lamports)
original_quantity: u64     // 8  — original quantity (for fill tracking)
side: u8                   // 1  — 0=USDC bid (Buy Yes), 1=Yes ask (Sell Yes), 2=No-backed bid (Sell No)
timestamp: i64             // 8  — Clock::get() at placement
is_active: bool            // 1  — false = slot is empty/cancelled
_padding: [u8; 7]          // 7
```
Note on `repr(C)` layout: `side` (u8, 1 byte) is followed by `timestamp` (i64, 8-byte aligned) — the compiler inserts **7 bytes of implicit padding** between them. With the explicit `_padding` at the end, the actual `repr(C)` size is **80 bytes** per slot (32 + 8 + 8 + 8 + 1 + 7_implicit + 8 + 1 + 7 = 80). Similarly, `PriceLevel` = 16 × 80 + 1 (count) + 7 (trailing alignment) = **1,288 bytes**. OrderBook = 32 + 8 + 99 × 1,288 + 1 (bump) + 7 (trailing) = **127,560 bytes ≈ ~125 KB**. These are estimates — **lock the exact size with `std::mem::size_of` in Phase 1A** before using as `space` in `create_strike_market`.

### PriceFeed (Mock Oracle, ~100 bytes)
```
ticker: [u8; 8]            // 8
price: u64                 // 8  — current price in USDC lamports
confidence: u64            // 8  — confidence band width in USDC lamports
timestamp: i64             // 8  — last update time
authority: Pubkey           // 32 — who can update (oracle feeder wallet)
is_initialized: bool       // 1
bump: u8                   // 1
_padding: [u8; 6]          // 6
```

### Anchor Events (emitted, not stored)
```
FillEvent {
  market: Pubkey,
  maker: Pubkey,
  taker: Pubkey,
  price: u8,
  quantity: u64,
  maker_side: u8,       // 0=USDC bid, 1=Yes ask, 2=No-backed bid
  taker_side: u8,       // 0=USDC bid, 1=Yes ask, 2=No-backed bid
  is_merge: bool,       // true if fill was a merge/burn (No-backed bid matched Yes ask)
  maker_order_id: u64,
  timestamp: i64,
}

SettlementEvent {
  market: Pubkey,
  ticker: [u8; 8],
  strike_price: u64,
  settlement_price: u64,
  outcome: u8,           // 1=YesWins, 2=NoWins
  timestamp: i64,
}
```

---

## Access Control Matrix

| Instruction | Who Can Call | Key Constraints |
|---|---|---|
| `initialize_config` | Admin (deployer) | One-time only. Sets admin, USDC mint, oracle program. |
| `create_strike_market` | Admin | Creates market + order book + mints + vaults. Accepts `market_close_unix` param (automation calculates from "4 PM ET today" with DST). |
| `mint_pair` | Any user | Market must not be settled or paused. **Position constraint: user's Yes ATA balance must be 0** (prevents minting when already holding Yes). **Intentionally does NOT check No balance** — users holding No need `mint_pair` + `place_order(side=1)` in one atomic tx to add to their No position (the "Buy No" flow). Checking No balance would break this path. Constraint fires during Anchor account deserialization, **before** any CPI — see "Position Constraint Timing" section. Creates Yes/No ATAs via `init_if_needed`. |
| `place_order` | Any user | Market not settled, not paused. Three side types: `side=0` (USDC bid, Buy Yes), `side=1` (Yes ask, Sell Yes), `side=2` (No-backed bid, Sell No). **Position constraint on side=0: user's No ATA balance must be 0** — see "Position Constraint Timing" section. Escrows USDC, Yes, or No tokens respectively. `max_fills` param caps compute (default 10). Min size: 1_000_000 lamports (1 token). When a No-backed bid matches a Yes ask, the engine merge/burns the pair — see "Merge/Burn Vault Math" section. |
| `cancel_order` | Order owner only | Can cancel anytime, including post-settlement. Returns escrowed asset (USDC, Yes, or No) based on order's `side` field. |
| `settle_market` | Anyone | `Clock::get() >= market_close_unix` (uses sysvar cache — no clock account needed). Oracle staleness (120s settlement threshold) + confidence (0.5% bps) validated. Sets outcome + `override_deadline = settled_at + 3600`. |
| `admin_settle` | Admin only | `Clock::get() >= market_close_unix.checked_add(3600)` (1hr delay, sysvar cache). Use `checked_add` — raw `+` could overflow on pathological `market_close_unix`. Accepts manual price. Fails if already settled. This is the "oracle completely failed" fallback — if the oracle recovers within the first hour, anyone can call `settle_market` first, making `admin_settle` unnecessary (intended behavior: oracle settlement is always preferred). |
| `admin_override_settlement` | Admin only | `Clock::get() < override_deadline` (within 1hr of original settlement, sysvar cache). Requires `is_settled == true`. Accepts corrected price. Rewrites outcome + settlement_price. Resets `override_deadline = now + 3600`. Increments `override_count`; fails with `MaxOverridesExceeded` if `override_count >= 3`. After deadline or max overrides, outcome is truly final. |
| `redeem` | Any token holder | Two modes with distinct preconditions: **(1) Pair burn** (Yes + No → $1 USDC): available **anytime**, no settlement required, not blocked by override window — economically the inverse of `mint_pair`, outcome-independent. **(2) Winner/loser redemption** (winning → $1, losing → $0): requires `is_settled == true`, **blocked during override window** (first hour after settlement) to prevent payouts based on potentially incorrect outcome. |
| `crank_cancel` | Anyone (permissionless) | Market must be settled. Iterates up to 32 order slots per call (hardcoded — not configurable, sufficient for prototype), cancels each and returns escrow (USDC, Yes, or No tokens based on order's `side`) to owner. Returns count of cancelled orders. Settlement service cranks until 0 remain. Worst case: full book (1,584 slots) requires ~50 crank calls (~20s at devnet tx speed). **Not blocked by override window** — escrow refunds are outcome-independent. No rate limiting needed — callers pay their own tx fees (natural rate limit), calls are idempotent, and external crankers are welcome (they reduce settlement service load and speed up escrow returns). |
| `pause` / `unpause` | Admin only | Sets `is_paused` on GlobalConfig (global) or StrikeMarket (per-market). |

**ATA Creation Strategy**: `mint_pair`, `place_order` (when filling — taker/maker may receive Yes, No, or USDC depending on side types), and `redeem` all use Anchor's `init_if_needed` for the recipient's ATA. This requires the `init_if_needed` feature flag in `Cargo.toml`. Payer = the user calling the instruction. Cost: ~0.002 SOL per new ATA (rent-exempt minimum).

---

## Transaction Size Strategy

**All transactions use v0 versioned transactions with Address Lookup Tables (ALTs).** No legacy transaction path.

**Per-market ALT**: Created as part of `create_strike_market` flow (script/service creates ALT immediately after market PDA). Pre-loaded with all market-related accounts:
- Market PDA, GlobalConfig, OrderBook, Yes Mint, No Mint, USDC Vault, Escrow Vault, Yes Escrow, No Escrow, Oracle PriceFeed
- Token Program, Associated Token Program, System Program, Rent Sysvar

**Cost**: ~0.002 SOL per ALT (rent-exempt minimum). Trivial on devnet.

**Benefit**: Each account reference costs 1 byte (ALT index) instead of 32 bytes. A 22-account transaction drops from ~700 bytes of keys to ~22 bytes. Transaction size is never a constraint, even for the heaviest instructions (Sell No merge/burn, Buy No with 3 ATA inits).

**Frontend**: All transaction builders use `VersionedTransaction` with the market's ALT. Single code path. All major wallets (Phantom, Solflare) support v0.

**ALT lifecycle**: Created as part of market creation flow, never modified or closed. The market creation script: (1) calls `create_strike_market` on-chain, (2) creates ALT client-side via `createLookupTable`, (3) extends ALT with all market PDAs + programs via `extendLookupTable`, (4) calls `set_market_alt` to write the ALT address into `StrikeMarket.alt_address`. **Activation delay**: ALTs require ~1 slot (~400ms) after `extendLookupTable` before entries are usable in transactions. The script must wait for the extend transaction to finalize (confirm with `confirmed` commitment), then wait 1 additional slot before the ALT is usable. Without this wait, the first trade on a newly-created market will fail with an invalid ALT error. **ALT address is non-deterministic** (`createLookupTable` takes `recentSlot`) — stored on-chain in `StrikeMarket.alt_address` (set to `Pubkey::default()` at creation, updated by `set_market_alt`). Frontend reads the market account to get the ALT address, then fetches the table via `connection.getAddressLookupTable(market.altAddress)`.

---

## Known Limitations (Document in Architecture Doc)

1. **Self-trades are allowed** — a user can fill their own orders. No economic harm, just wasteful.
2. **Admin trust assumption** — admin can call `admin_settle` with arbitrary price after 1hr delay, or `admin_override_settlement` to correct a bad oracle settlement within 1hr. No on-chain governance. Mitigated: override window is time-limited, capped at 3 overrides (3 hours total), and outcome becomes truly immutable after deadline or cap.
3. **Market account closure is phased** (Phase 6) — on devnet, settled markets remain on-chain forever (free airdrops cover rent). On mainnet, three-phase lifecycle: `close_market` (partial close at 90 days, reclaims ~98% of rent), `treasury_redeem` (indefinite late claims), `cleanup_market` (final close once supply = 0). Orphaned mints from lost wallets (~0.004 SOL/market) remain indefinitely — acceptable cost. See DEV_LOG for future cleanup paths (Token-2022 migration, governance-gated burns, economic incentives).
4. **Mock oracle is centralized** — single authority keypair. Compromise = bad prices. Swap for Pyth on mainnet (Phase 6).
5. **Order book depth** — 16 orders per price level. If exceeded, new orders at that level are rejected with `OrderBookFull` (6051). Frontend should display "This price level is full — try a different price." Sufficient for prototype.
6. **No partial redemption** — `redeem` burns all of a user's tokens for a market in one call. Users who want to redeem only a portion must first transfer the remainder to another wallet. Simpler implementation; the spec does not require partial redemption. If needed later, add a `quantity` parameter to `redeem`.
7. **Override cap** — admin can override settlement up to 3 times (3 hours total window). After that, outcome is truly final regardless of deadline. Prevents indefinite market limbo.
8. **Order slot spam** — a user could fill all 16 slots at a price level with minimum-size orders (1 token each, $0.01–$0.99 cost), blocking other users at that level. Mitigation: `cancel_order` is permissionless for the owner, and `crank_cancel` clears post-settlement. Mainnet mitigation: increase `MIN_ORDER_SIZE` to 10 tokens ($0.10–$9.90 cost per order), making spam economically costly.
9. **Multi-wallet position constraint bypass** — On-chain position checks (`ConflictingPosition`) enforce single-wallet constraints, but SPL tokens are freely transferable. A user could transfer No to wallet B, then Buy Yes from wallet A. This requires deliberate effort and is the user's own capital inefficiency — not a safety risk.

---

## Operational Details

### Trading Day Detection
- Automation service calls Tradier `/v1/markets/clock` at startup
- If `state != "open"` and today is not a trading day, skip all operations
- Half-days: use the clock's `next_close` timestamp instead of hardcoded 4 PM ET
- Weekends and holidays are automatically handled

### Timezone Handling
- All on-chain timestamps are UTC unix seconds
- `create_strike_market` accepts `market_close_unix` (UTC) as a parameter
- Automation service converts "4:00 PM ET today" → UTC using `America/New_York` timezone
- DST transitions (March, November) handled automatically by timezone library
- No hardcoded UTC offsets (-5 or -4)

### Idempotent Market Creation
- `create_strike_market` will fail with `AccountAlreadyInUse` if PDA already exists (same ticker + strike + date)
- Market-initializer catches this error and logs "market already exists, skipping"
- Re-running the morning job is safe

### Settlement Service Recovery
- On startup/restart, queries all StrikeMarket accounts for today
- Filters by `is_settled == false`
- Attempts settlement for each unsettled market
- Already-settled markets are naturally skipped
- Idempotent by design

### Rate Limiting Budget (Tradier: 60 req/min REST)

**Batch optimization**: Tradier's `/v1/markets/quotes` accepts comma-separated symbols (`symbols=AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA`) — all 7 MAG7 in 1 call. The quote response includes `prevclose` (previous closing price), so no separate call needed for strike calculation inputs. History and options chains do NOT support batching — 1 symbol per request.

**Call budget by service:**
- **Oracle feeder**: Tradier streaming (WebSocket session via `POST /v1/markets/events/session`, then `stream.tradier.com`) — **0 REST calls during operation**. All 7 symbols on one stream.
- **Market initializer (morning, one-time)**:
  - 1 batch quote call (all 7 prev closes via `prevclose` field) = **1 call**
  - 7 history calls (60-day OHLCV for HV calculation, no batch support) = **7 calls**
  - 1 market calendar call (cache monthly, pre-fetch trading days/holidays/half-days) = **1 call**
  - 1 market clock call (current session state, half-day close time) = **1 call**
  - **Total morning burst: 10 calls** (was 14)
- **Frontend proxy (user-triggered, cached 60s TTL)**:
  - 1 batch quote call (all 7 live prices, bid/ask, volume) = **1 call**
  - 7 options chain calls (per-symbol + expiration, `greeks=true`) = **7 calls**
  - **Total per cache refresh: 8 calls** (was 14)
- **AMM bot**: Reads oracle on-chain, not Tradier directly. **0 REST calls.**
- **Total steady-state REST**: well under 60/min. Morning burst of 10, then near-zero until a frontend user triggers a cache miss.
- Shared Tradier client with token-bucket rate limiter in `services/shared/src/tradier-client.ts`

### Frontend Setup Notes
- `"use client"` directive required on all wallet/Anchor components
- `next.config.js`: webpack fallback for `crypto`, `stream`, `buffer` (Node.js polyfills)
- All Tradier API calls go through `/api/tradier/*` Next.js API routes (CORS restriction)
- Anchor error mapping in `lib/errors.ts`: error code → user-friendly message
- `useTransaction` hook wraps sign → send → confirm with loading states ("Signing...", "Confirming...", success/failure toast)
- Wallet adapter: Phantom + Solflare. Network = devnet. RPC from `NEXT_PUBLIC_SOLANA_RPC_URL` env var. All transactions use `VersionedTransaction` (v0) with per-market ALTs.
- Mock wallet provider for Vitest + React Testing Library tests in `tests/helpers/`

### Compute Budget
- Simple instructions (mint, cancel, redeem): default 200k CUs
- Standard matching instructions (place_order with swap fills only): request 400k CUs via `ComputeBudgetProgram.setComputeUnitLimit`. Each swap fill involves ~2 CPIs (1 transfer out of escrow + 1 transfer to buyer), estimated ~40,000–60,000 CUs per fill.
- **Merge/burn matching** (place_order where No-backed bid matches Yes ask): request **800k CUs**. Each merge/burn fill involves 4 CPIs (2 token burns + 2 USDC transfers) + invariant check — estimated **80,000–120,000 CUs per fill**. CPI calls to Token Program are ~20,000–30,000 CUs each; 4 per fill dominates the cost.
- `place_order` accepts a **single `max_fills` parameter** on-chain — the program applies it as a global cap across all fill types encountered during matching. **The client sets `max_fills` and CU budget based on the taker's side type:**
  - **side=0 (USDC bid)**: can only match Yes asks → always swap fills → `max_fills=10`, request 400k CUs.
  - **side=2 (No-backed bid)**: can only match Yes asks → always merge/burn fills → `max_fills=5`, request 800k CUs.
  - **side=1 (Yes ask)**: can match USDC bids (swap) OR No-backed bids (merge/burn) — **mixed fills possible**. Client reads the opposite side of the book: if only USDC bids → `max_fills=10`, 400k CUs; if any No-backed bids present → `max_fills=5`, 800k CUs (budget for worst-case all merge/burn). A smarter client could inspect the book depth and interpolate, but worst-case budgeting is correct and simpler.
  If order can't fully fill within `max_fills` matches, remainder rests as limit order. Bounds compute predictably. **`max_fills` is the primary CU safety valve** — if Phase 2 CU measurements come in higher than estimated, lower the default before adjusting the CU request.
- **CU measurement gate (Phase 2C)**: Run two dedicated tests — a 10-fill swap sweep and a 5-fill merge/burn sweep — reading `compute_units_consumed` from transaction metadata for each. This measurement locks the `max_fills` defaults and CU request values for the rest of the build. **Swap path thresholds**: if CU per swap fill > 60,000 → lower swap `max_fills` to 8; if < 30,000 → raise to 12–15. **Merge/burn path thresholds**: if CU per merge/burn fill > 100,000 → cap merge/burn `max_fills` at 5; if > 80,000 → cap at 6; if < 60,000 → raise to 8. Record both measurements in DEV_LOG.
- Monitor program binary size during Phase 2 — if instructions + matching engine (with merge/burn) exceed 200KB BPF limit, use `solana program deploy --max-len`

### Prerequisites — What the Developer Needs Before Building

**No manual setup required.** Tradier API key is already in `.env`. Everything else is handled automatically by the build/deploy scripts.

**Everything below is automated — do NOT do these manually:**
- Devnet SOL: airdropped by deploy scripts (free, unlimited on devnet)
- Mock USDC mint: created by `create-mock-usdc.ts`
- GlobalConfig, oracle feeds, test markets: created by init scripts
- ATAs, escrow accounts, vaults: created by on-chain instructions via `init_if_needed`
- Solana keypair: already exists at `~/.config/solana/id.json` (Solana CLI default)

A zero SOL balance is expected and normal — scripts handle funding as step 1.

### `declare_id!` Lifecycle
Anchor requires `declare_id!("programId...")` in each program's `lib.rs`. On first build, use a placeholder. After first `anchor deploy`, the actual program ID is written to `target/deploy/<name>-keypair.json`. Update `declare_id!` in both `programs/meridian/src/lib.rs` and `programs/mock-oracle/src/lib.rs` with the deployed IDs, then rebuild and redeploy. Subsequent deploys (upgrades) reuse the same program ID — no further `declare_id!` changes needed. `anchor deploy` handles this: it reads the keypair from `target/deploy/` and deploys to the matching address. The deploy script should automate the update-rebuild-redeploy cycle on first deploy.

### Initialization Order
Script dependencies must run in this order (all automated by `make dev`):
1. `solana airdrop` — fund deployer wallet with SOL (devnet, free)
2. `anchor deploy` — deploy both programs (see `declare_id!` lifecycle above for first-deploy cycle)
3. `scripts/create-mock-usdc.ts` — create mock USDC mint, auto-write `FAUCET_KEYPAIR` + `USDC_MINT` + `NEXT_PUBLIC_USDC_MINT` to `.env`
4. `scripts/init-config.ts` — initialize GlobalConfig with admin, USDC mint (reads from `.env`), oracle program
5. `scripts/init-oracle-feeds.ts` — initialize PriceFeed for all 7 tickers
6. `scripts/create-test-markets.ts` — create markets for today's strikes
7. Start oracle feeder → start AMM bot → start frontend

---

## Build Phases

Each phase is broken into **stages**. Stages use three execution modes:

- **Sequential**: Steps numbered 1, 2, 3… — must execute in listed order, each completed before the next starts.
- **Gate → Parallel**: A gate step (numbered) must complete first, then all bulleted items below it run concurrently.
- **Parallel**: All bulleted items run concurrently with no internal dependencies.

Dependency graphs are shown in ASCII where the flow isn't obvious. Every phase ends with an **audit** checkpoint.

All smart contract tests use `solana-bankrun` for clock manipulation (settlement timing, admin delays, oracle staleness). Fallback: `solana-test-validator` with `warp_to_slot` if bankrun has ZeroCopy deserialization issues with the ~125 KB OrderBook account. **See "Bankrun + ZeroCopy Decision Point" section — compatibility must be validated in Stage 1D and the decision locked before Phase 2.**

### Phase 1: Foundation ✅ COMPLETE (2026-03-09)
**Goal**: Both programs deployed on devnet. Can mint Yes/No token pairs via CLI.

**Stage 1A — Sequential: workspace + data model** ✅
These define the on-chain data model and project structure. Everything else in Phase 1 depends on them.
1. ✅ Anchor workspace scaffolding (Cargo.toml, Anchor.toml, npm workspaces, directory structure)
2. ✅ PDA seed definitions (Rust side) — all seeds from PDA Registry, exact byte encoding
3. ✅ Meridian state accounts: `GlobalConfig`, `StrikeMarket` (with Yes/No mints + USDC vault + escrow vault + Yes escrow + No escrow + OrderBook as PDAs). Treasury PDA (`[b"treasury"]`) created during `initialize_config`.
4. ✅ Mock oracle state: `PriceFeed` account
5. ✅ Error enum (`error.rs`) — all Phase 1 error codes (6000–6016, 6030–6036, 6040–6044, 6060–6066, 6100–6101)

**Stage 1B — Parallel: isolated modules (once 1A is complete)** ✅
All depend on Stage 1A workspace + state being defined, but not on each other.
- [x] Mock oracle program: `initialize_feed`, `update_price` instructions
- [x] Meridian instructions: `initialize_config`, `create_strike_market`, `set_market_alt`, `mint_pair` + `allocate_order_book` (new — see architectural changes below)
- [x] Tradier client library (`services/shared/src/tradier-client.ts` — pure HTTP, no chain interaction)
- [x] Frontend lib layer: `greeks.ts`, `volatility.ts`, `strikes.ts` (pure math, no deps). `strikes.ts` includes strike selection baseline: ±3%, ±6%, ±9% from previous close, rounded to nearest $10, deduplicate.
- [x] PDA derivation helpers `pda.ts` (TypeScript side — mirrors Rust seeds from 1A)
- [x] Deploy + init scripts (`deploy-devnet.sh`, `init-config.ts`, `init-oracle-feeds.ts`, `create-mock-usdc.ts`)

**Stage 1C — Sequential: integration + deploy (once all of 1B is complete)** ✅
1. ✅ `anchor build --no-idl` — both programs compile (IDL generation deferred due to Anchor 0.30.1 nightly toolchain issue)
2. ✅ Deploy to devnet — both programs deploy
3. ✅ Run init scripts in dependency order: (a) `create-mock-usdc.ts` — USDC mint must exist first, (b) `init-config.ts` — references USDC mint + oracle program, creates Treasury PDA, (c) `init-oracle-feeds.ts` — references GlobalConfig for authority, (d) `create-test-markets.ts` — references GlobalConfig + oracle feeds, creates markets + OrderBook pre-allocation + calls `set_market_alt` to write ALT address on-chain
4. ✅ Verify: mint a Yes/No pair via CLI script, confirm vault balance = $1 × pairs minted

**Stage 1D — Parallel: tests (bankrun, once 1C passes)** ✅ 36/36 passing
All test suites are independent of each other. Run against bankrun (local), not devnet. **Each test file must spawn its own isolated bankrun instance** — call `start()` at the top, initialize fresh GlobalConfig/PriceFeed/StrikeMarket state within the test, and never share state across test files. This is what makes true parallelism safe; shared bankrun state would cause race conditions between tests that write to the same accounts.
- [x] Oracle CRUD: initialize feed, update price, authority validation, staleness check
- [x] Config init: admin set, tickers stored, thresholds stored
- [x] Market creation: PDA derivation correct, mints created, vaults created, duplicate rejected
- [x] Mint pair: vault balance invariant (vault = $1 × pairs minted), Yes supply = No supply, ATAs created via `init_if_needed` (test fresh user with no existing ATA), insufficient USDC balance rejected with `InsufficientBalance`
- [x] Mint pair position constraint: rejects with `ConflictingPosition` if user holds Yes tokens; **allows** minting when user holds only No tokens (required for atomic Buy No flow)
- [x] OrderBook initialization: ZeroCopy account created with correct size (~125 KB), `next_order_id` starts at 0, all 99 levels empty
- [x] Treasury creation: `initialize_config` creates Treasury PDA (`[b"treasury"]`) as USDC token account owned by GlobalConfig PDA
- [x] Escrow setup: `create_strike_market` creates all three escrow accounts (escrow_vault, yes_escrow, no_escrow) with correct mint and market PDA ownership
- [x] `set_market_alt`: writes ALT address to `StrikeMarket.alt_address`, rejects if already set (prevents overwrite), rejects non-admin caller

**Stage 1E — Audit** ✅ 13 issues found and fixed
Run `/audit` against all Phase 1 code. Verified:
- ✅ All error codes used correctly
- ✅ No `unwrap()` in production code
- ✅ PDA seeds match between Rust and TypeScript
- ✅ Vault invariant tested
- ✅ No dead code, no commented-out code

**Demo checkpoint**: ✅ `anchor test` passes locally (36/36). Programs deployed on devnet. Mint a pair via CLI.

#### Phase 1 Architectural Changes (deviations from original plan)

1. **OrderBook allocation pattern changed**: The ~127KB ZeroCopy OrderBook exceeds Solana's 10,240-byte CPI `MAX_PERMITTED_DATA_INCREASE` limit. `#[account(init)]` cannot create it in a single instruction.
   - **Solution**: Changed `create_strike_market` to use `#[account(zero)]` constraint (expects pre-allocated, zeroed, program-owned account). Client pre-allocates before calling `create_strike_market`.
   - **Devnet**: New `allocate_order_book` instruction handles incremental allocation (~13 calls of 10KB each). Can be batched into 2-3 transactions.
   - **Bankrun tests**: Use `context.setAccount()` to inject the pre-allocated OrderBook directly (no multi-call overhead).
   - **Impact on Phase 2+**: `create-test-markets.ts` script updated to call `allocate_order_book` before `create_strike_market`. No impact on trading instructions — OrderBook is fully allocated before any orders are placed.

2. **`expiry_day` validation added** (audit fix): `create_strike_market` now validates `expiry_day == floor(market_close_unix / 86400)` to prevent PDA seed mismatches between creation and later derivation in `mint_pair`.

3. **Post-expiry mint guard added** (audit fix): `mint_pair` now rejects with `MarketClosed` if `clock.unix_timestamp >= market.market_close_unix`.

4. **`greeks.ts` division-by-zero guards** (audit fix): `binaryDelta` and `binaryGamma` return 0 when `sigma <= 0` or `S <= 0`.

5. **Deploy script flag fix** (audit fix): `--program-keypairs` → `--program-keypair` (singular).

6. **Test assertions hardened** (audit fix): Replaced weak `expect(err).to.exist` with specific error code/message regex patterns across all negative test cases.

7. **Tradier rate limiter** (audit fix): Made concurrency-safe with promise queue pattern.

8. **`GlobalConfig.is_valid_ticker`** (audit fix): Added defensive `.min(self.tickers.len())` bounds check on `ticker_count`.

---

### Phase 2: Trading ✅ COMPLETE (2026-03-09)
**Goal**: Users can place orders. Matching engine fills. All 4 trade paths working.

**Stage 2A — Sequential then parallel: order book + matching engine + escrow (funds-critical)**

Steps 1–3 are strictly sequential — each defines data structures or logic the next step consumes. After step 3, the dependency graph fans out.

```
1 (order book state) → 2 (matching engine) → 3 (escrow logic)
                                                  ↓
                                           3.5 (gate: error codes + mod.rs registration)
                                                  ↓
                                        ┌─────────┼─────────┐
                                        4         5         6
                                   (place_order) (cancel)  (pause/unpause)
                                        ↓
                                        7
                                   (Buy No atomic)
```

1. Order book state design: ZeroCopy account, 99 price levels (1-99 cents), 16 order slots per level, `OrderSlot` struct (with `side: u8` — 0=USDC bid, 1=Yes ask, 2=No-backed bid), `PriceLevel` struct
2. Matching engine (`matching/engine.rs`): pure functions — price-time priority, partial fills, fill events. Market orders (take best available) + limit orders (rest on book). `max_fills` param caps compute. **Three settlement paths based on order side types:**
   - USDC bid × Yes ask → standard swap (USDC to seller, Yes to buyer)
   - No-backed bid × Yes ask → merge/burn (see "Merge/Burn Vault Math" section for exact payout formula and invariant checks)
   - USDC bid × USDC bid or ask × ask → never match (same side)
   **30+ unit test scenarios before integration** (up from 20+ — need to cover all side-type combinations and merge/burn vault math).
3. Escrow logic: three escrow types — lock USDC (USDC bids → `escrow_vault`), Yes tokens (Yes asks → `yes_escrow`), or No tokens (No-backed bids → `no_escrow`) on order placement. Unlock and return correct asset on cancel. **Tested independently for all three types.**

Once steps 1–3 are complete, **gate step 3.5** must run before parallel work begins:

3.5. **Gate: error codes + instruction registration** — Add Phase 2 error codes (6050–6059) to `error.rs`. Register all four new instruction modules in `programs/meridian/src/instructions/mod.rs` (`pub mod place_order; pub mod cancel_order; pub mod pause; pub mod unpause;`) and add instruction dispatch arms in `programs/meridian/src/lib.rs`. **This prevents merge conflicts** — parallel agents write only their own instruction handler file, never `mod.rs` or `lib.rs`.

Once gate 3.5 is complete, the following can proceed in parallel:
- [x] `place_order` instruction (`instructions/place_order.rs` only): wires matching engine + escrow together. Accepts `side: u8` (0/1/2) and `order_type` (Market/Limit). Min size: 1 token. For side=2 (Sell No): user must hold sufficient No tokens; escrowed in no_escrow. Error codes 6050–6059 already in `error.rs` from gate 3.5.

  **`place_order` account list** (heaviest instruction — documented explicitly for tx size validation):
  ```
  Fixed accounts (always present, 16 accounts):
   1. signer              — user/taker, mut, signer
   2. global_config       — GlobalConfig, read-only
   3. market              — StrikeMarket, mut
   4. order_book          — OrderBook, mut (ZeroCopy)
   5. usdc_vault          — main collateral vault, mut (for merge/burn debits)
   6. escrow_vault        — USDC escrow, mut
   7. yes_escrow          — Yes token escrow, mut
   8. no_escrow           — No token escrow, mut
   9. yes_mint            — mut (for merge/burn burns)
  10. no_mint             — mut (for merge/burn burns)
  11. user_usdc_ata       — mut (escrow source for side=0, payout dest for merge/burn)
  12. user_yes_ata        — mut (escrow source for side=1, receipt for swap fills)
  13. user_no_ata         — mut (escrow source for side=2, position constraint for side=0)
  14. token_program       — SPL Token
  15. associated_token_program
  16. system_program

  Notes on accounts NOT in this list:
  - clock sysvar: NOT required as an explicit account. Order timestamps use
    `Clock::get()?.unix_timestamp` via sysvar cache (Solana 1.9+). Same for all
    instructions that need clock (settle_market, admin_settle, admin_override, etc.).
  - rent sysvar: NOT required as an explicit account. Solana 1.9+ exposes rent via sysvar
    cache; Anchor's init_if_needed uses this automatically. No account slot needed.
  - market ALT: NOT an instruction account. ALTs are referenced in the v0 transaction
    message header (lookup table address list), not passed as instruction accounts.
    The ALT is a client-side concern — the on-chain program never sees it.

  Per-fill remaining accounts (up to max_fills makers):
  Per maker matched, 2-3 accounts passed via remaining_accounts:
   - maker               — wallet Pubkey (for ATA derivation)
   - maker_usdc_ata      — mut, init_if_needed (receives USDC on swap/merge fills)
   - maker_yes_ata       — mut, init_if_needed (receives Yes tokens when filling a USDC bid)
  The instruction reads order.side from the book to determine which maker ATAs are needed per fill.

  Worst case: 16 fixed + 3 × 10 (swap) = 46 accounts, or 16 + 3 × 5 (merge/burn) = 31 accounts.
  With ALTs: 46 accounts × 1 byte = 46 bytes of keys. Well under 1,232-byte tx limit.
  ```

  **Remaining accounts staleness**: The on-chain book may change between client read and tx landing. The matching engine handles cancelled resting orders gracefully (skips to next). To handle missing maker ATAs: (1) client should over-include remaining_accounts for `max_fills + 2` makers (unused accounts cost ~1 byte each with ALT, negligible); (2) on-chain, if the engine encounters a fill where the maker's accounts aren't in remaining_accounts, skip that fill and advance to the next resting order — the unfilled maker's order stays on the book. Add a `skipped_fills` counter to the FillEvent so the client knows fills were missed and can retry.
- [x] `cancel_order` instruction (`instructions/cancel_order.rs` only): owner-only, refund from escrow (checks order's `side` to return USDC, Yes, or No), cancel by `(price_level, order_id)`. Works post-settlement.
- [x] `pause` / `unpause` instructions (`instructions/pause.rs` and `instructions/unpause.rs`): admin only. Global (`GlobalConfig.is_paused`) or per-market (`StrikeMarket.is_paused`). Reads/writes `is_paused` flags — no dependency on matching engine or escrow.

**Parallel safety rule**: Each parallel agent writes ONLY its own `instructions/<name>.rs` file. No agent touches `lib.rs`, `mod.rs`, or `error.rs` — those are locked after gate 3.5.

Once `place_order` is complete:
- [x] Buy No atomic path: `mint_pair` + `place_order(side=1)` (Yes ask) composed in one transaction. Market variant (sell at best bid) and limit variant (post at user-chosen price). A Buy No limit (Yes ask) naturally matches against Sell No limit (No-backed bid) through the book. This is a client-side composition test — both instructions already exist.

**Stage 2B — Gate → parallel: frontend trading UI (once 2A is complete)**

```
IDL generation (gate)
  ↓
wallet adapter + lib/orderbook.ts + faucet API routes (parallel, truly independent)
  ↓
useTransaction hook + wallet state awareness (parallel, both need wallet adapter)
  ↓
MarketCard + wallet balance display (parallel, need wallet state)
  ↓
useMarkets / useMarket / useOrderBook hooks (need lib/orderbook.ts + wallet adapter)
  ↓
OrderBook component + OrderForm (parallel, need hooks)
  ↓
position constraints (needs OrderForm)
```

1. IDL generation: `anchor build` → copy IDL to `app/meridian-web/src/idl/` and `services/shared/src/idl/`. **IDL must exist at both paths before any hook implementation begins.**

Once IDL is generated, the following run in parallel (truly independent — no shared imports):
- [ ] Frontend wallet adapter + Anchor program client hooks (`useAnchorProgram`)
- [ ] `lib/orderbook.ts`: `buildNoView(book)` — separates USDC bids, Yes asks, and No-backed bids into Yes/No depth views. Depth aggregation, spread calculation. No-backed bids at price X appear as No asks at price (100-X) in the Yes perspective. **Custom deserializer**: Do NOT use Anchor's generic `program.account.orderBook.fetch()` for the ~125 KB ZeroCopy OrderBook — it allocates thousands of objects. Instead, write a `deserializeOrderBook(buffer: Buffer)` function that reads the raw buffer with `DataView`, skips inactive slots (`is_active == false`), and returns only active orders grouped by price level. This turns a ~125 KB parse into a sparse read of only live orders. **Verification requirement**: unit tests must confirm that the No perspective correctly inverts prices for all three order side types — a USDC bid at price 60 (Buy Yes at $0.60) must appear as a No ask at price 40 ($0.40) in the No view; a Yes ask at price 70 must appear as a No bid at price 30; a No-backed bid at price 55 must appear as real No depth at price 55 (no inversion — it's already a No-native order). Test edge cases: price 1 → 99, price 99 → 1, price 50 → 50.
- [ ] **Devnet faucet**: `/api/faucet/sol` (calls `connection.requestAirdrop`, 2 SOL per click) + `/api/faucet/usdc` (server-side mint-to using faucet keypair, 1000 USDC per click). Rate-limited: 1 request per wallet per 60 seconds (in-memory map, no DB). Faucet keypair = USDC mint authority, stored in `FAUCET_KEYPAIR` env var (base58-encoded secret key).

Once wallet adapter is complete (lib/orderbook.ts and faucet can still be in-flight):
- [ ] `useTransaction` hook: sign → send → confirm lifecycle with loading states ("Signing...", "Confirming...", toast). Depends on wallet adapter for signing.
- [ ] **Wallet state awareness**: App-wide state machine for connected wallet — (1) no wallet: read-only markets, "Connect Wallet" CTA; (2) wallet connected, zero SOL: SOL faucet prompt; (3) wallet connected, zero USDC: USDC faucet prompt; (4) wallet connected, funded: full trading UI; (5) wallet connected, has positions: portfolio badge in nav. State derived from on-chain balances via `useWalletState` hook. Depends on wallet adapter for balance queries.

Once wallet state + useTransaction are complete:
- [ ] `MarketCard` component: strike, Yes price, No price ($1 - Yes), implied probability (Yes price as %), active order count. Uses wallet state for conditional rendering.
- [ ] Wallet USDC balance display (always visible in header). Uses `useWalletState`.

Once `lib/orderbook.ts`, wallet adapter, and wallet state are all complete:
- [ ] `useMarkets` / `useMarket` / `useOrderBook` hooks (TanStack Query, polling + WebSocket subscription)

Once hooks are complete:
- [ ] `OrderBook` component: bid/ask depth with three side types. `perspective: "yes" | "no"` prop. Yes view: USDC bids on left, Yes asks on right. No view: No-backed bids shown as real No depth (not synthetic inversion), Yes asks shown as No asks at inverted price. WebSocket subscriptions.
- [ ] `OrderForm` component: side selector (Buy Yes / Sell Yes / Buy No / Sell No), market/limit toggle, price input, quantity input, submit. Sell No submits `place_order(side=2)` with No token escrow.

Once OrderForm is complete:
- [ ] Position constraint enforcement (frontend UX layer): check Yes/No token balances, block conflicting trades in UI before tx submission, prompt user to exit first. On-chain checks (`ConflictingPosition`) are the backstop; frontend prevents users from ever hitting them. Depends on OrderForm existing to add constraint logic on top.

**Stage 2C — Tests (bankrun for on-chain, vitest for frontend)**

On-chain unit tests (matching engine — run these first, they validate the core):
- [ ] Matching engine: 20+ scenarios (exact fill, partial fill, sweep multiple levels, no cross, book full at level, price-time priority, market order fills, limit order rests)
- [ ] Escrow: USDC locked on bid (→escrow_vault), Yes locked on ask (→yes_escrow), No locked on No-backed bid (→no_escrow), returned on cancel, correct asset transferred on fill
- [ ] Merge/burn vault math: vault decrements by quantity, total_redeemed increments, invariant holds
- [ ] **CU measurement (both paths)**: Execute two worst-case sweeps: (1) a 10-fill swap sweep (USDC bid sweeping 10 Yes asks), and (2) a 5-fill merge/burn sweep (No-backed bid sweeping 5 Yes asks across price levels). Read `compute_units_consumed` from transaction metadata for each. Log actual CU per fill. **This test locks the per-path `max_fills` defaults and CU request values.** Swap thresholds: per-fill > 60k → lower swap `max_fills` to 8; < 30k → raise to 12–15. Merge/burn thresholds: per-fill > 100k → cap at 5; > 80k → cap at 6; < 60k → raise to 8. Record both measurements in DEV_LOG.

On-chain integration tests (need deployed instructions — parallel with each other):
- [ ] Place order: happy path, insufficient balance, paused market, settled market, min quantity, price bounds
- [ ] Position constraint (on-chain): place_order side=0 rejects with `ConflictingPosition` when user holds No tokens; mint_pair rejects when user holds Yes tokens; atomic Buy No (mint+sell in one tx) passes when user starts with 0 of both; adding to existing No position via mint+sell passes (Yes balance is 0)
- [ ] Cancel order: refund correctness, wrong owner rejection, order not found, post-settlement cancel
- [ ] Buy No (market): atomic mint + sell, user gets No tokens, USDC deducted
- [ ] Buy No (limit): atomic mint + post sell, user holds both tokens, Yes order on book
- [ ] Sell No (market): place_order(side=2) with No escrow, sweeps Yes asks, merge/burn if matched against Yes ask
- [ ] Sell No (limit): place_order(side=2) posts No-backed bid on book, matched later by incoming Yes ask → merge/burn
- [ ] No-backed bid × Yes ask merge/burn: both tokens burned, $1 from vault released, split correctly
- [ ] Cross-matching (two sellers): Yes ask + No-backed bid match without any buyer, both exit positions via merge/burn
- [ ] All 4 trade paths e2e (including Buy No limit variant where user holds both tokens)

Frontend tests (vitest + React Testing Library — parallel with on-chain tests):
- [ ] Order book rendering (both perspectives): verify No perspective correctly inverts prices for all three order side types — USDC bid at price 60 → No ask at price 40; Yes ask at price 70 → No bid at price 30; No-backed bid at price 55 → No depth at price 55 (no inversion). Edge cases: price 1↔99, price 99↔1, price 50↔50.
- [ ] Order form validation, position constraint enforcement, wallet connection

**Stage 2D — Audit**
Run `/audit` against all Phase 2 code. Verify:
- Matching engine correctness: price-time priority, partial fills, no fund leaks across all three side types
- Escrow balances (USDC, Yes, No) always match outstanding orders by side
- Merge/burn correctness: vault decrements exactly, total_redeemed increments, Yes+No supply stays equal after burns
- No CU overflows on max_fills sweeps: verify standard swap path (max_fills=10) stays under 400k CUs, merge/burn path (max_fills=5) stays under 800k CUs. Confirm per-path `max_fills` defaults match the CU measurement gate results from Stage 2C.
- Frontend: no direct RPC calls in components (hooks only)
- TypeScript strict mode, no `any` types

**Demo checkpoint**: Two users can trade Yes tokens on a market via the web frontend. All 4 trade paths work.

---

### Phase 2.5: Complexity Sweep (covers Phase 1 + 2)
Run `/complexity-sweep` across all Phase 1 + 2 code. This is the first sweep — Phase 1 alone doesn't produce enough code to warrant a standalone pass, but after Phase 2 the matching engine, escrow logic, and 6 instructions are all present. Focus areas:
- Rust: instruction handler length (max ~300 lines/file), state account complexity, error handling consistency
- Rust: matching engine complexity (most likely hotspot — partial fills, sweep logic, three escrow types, merge/burn path), `place_order` handler length (handles all three side types)
- TypeScript: PDA helpers, Tradier client, math libs — flag any function > 40 lines or file > 300 lines
- TypeScript: frontend hooks and components — flag state duplication, oversized components (>150 lines), hooks doing too much
- Order book data flow: is the path from on-chain account → hook → component clean, or are there unnecessary transforms?
- Identify coupling between matching engine and instruction handlers — engine should be pure functions, handlers should be thin glue
- Identify any premature abstractions or missing extractions
- If issues found, refactor before proceeding. Phase 3 adds settlement on top of the matching engine — any complexity debt here compounds.

---

### Phase 3: Full Lifecycle ⚠️ IN PROGRESS (Stage 3A complete, Stage 3B next)
**Goal**: Complete economic loop. Markets settle, winners get paid. Daily automation running.

**Stage 3A — Sequential then parallel: settlement + redemption (funds-critical)** ✅ COMPLETE (87 tests passing, audited, pushed)

```
error codes (0 — needed by all instructions below)
  ↓
settle_market (1)
  ↓
admin_settle (2) ∥ admin_override (3)
  ↓ (both done)
redeem (4) ∥ crank_cancel (5)
```

0. **Gate: error codes + instruction registration** — Add Phase 3 codes (6020–6024, 6070–6074, 6080–6082, 6090) to `error.rs`. Register Phase 3 instruction modules in `instructions/mod.rs` (`pub mod settle_market; pub mod admin_settle; pub mod admin_override_settlement; pub mod redeem; pub mod crank_cancel;`) and add dispatch arms in `lib.rs`. **Note**: `pause` and `unpause` were already registered in Phase 2A gate 3.5 — do NOT re-register them here. **Same pattern as Phase 2A gate 3.5** — prevents merge conflicts on shared registration files.
1. `settle_market` instruction (`instructions/settle_market.rs` only): anyone calls, requires `Clock >= market_close_unix`. Oracle validation (120s settlement staleness, 0.5% confidence bps). Closing price >= strike → Yes wins. Sets `is_settled`, writes `outcome`, `settlement_price`, `settled_at`, `override_deadline = settled_at + 3600`.

Once `settle_market` is complete, the following are parallel (independent preconditions, no shared code paths — each writes only its own instruction file):
- [x] `admin_settle` instruction (`instructions/admin_settle.rs` only): admin only, requires `Clock >= market_close_unix + 3600`. Accepts manual price. Fails if already settled. (For unsettled markets where oracle failed entirely.)
- [x] `admin_override_settlement` instruction (`instructions/admin_override_settlement.rs` only): admin only, requires `is_settled == true` AND `Clock < override_deadline` AND `override_count < 3`. Corrects outcome + settlement_price. Resets `override_deadline = now + 3600`. Increments `override_count`. Must correctly flip winning/losing status. (For already-settled markets where oracle was wrong.)

Once both admin settlement paths are complete, the following are parallel (no dependency on each other — each writes only its own instruction file):
- [x] `redeem` instruction (`instructions/redeem.rs` only): two modes — **(1) Pair burn** (Yes + No → $1 USDC): available anytime, no settlement required, not blocked by override window (outcome-independent, inverse of `mint_pair`). **(2) Winner/loser redemption** (winning → $1, losing → $0): requires `is_settled == true`, **blocked during override window** (`Clock < override_deadline`). Needs override logic finalized to correctly check the window for mode 2.
- [x] `crank_cancel` instruction (`instructions/crank_cancel.rs` only): permissionless, market must be settled. Iterates up to 32 order slots per call. Returns escrowed assets based on order's `side`: USDC (side=0 bids), Yes tokens (side=1 asks), No tokens (side=2 No-backed bids) to owners. Skips already-cancelled slots. Returns count. **Not blocked by override window** (escrow refunds are outcome-independent).

**Stage 3B — Gate → parallel: frontend + services (once 3A is complete)**

```
IDL regeneration + alerting module + navigation scaffold (gate — all must complete)
  ↓
Pages (Portfolio, History, Market Maker) + UI elements + services (parallel)
  Exceptions:
    - settlement service e2e tests require oracle feeder operational
    - History page depends on event indexer API contract (not full implementation)
```

Gates (must complete before parallel work begins):
1. IDL regeneration: `anchor build` → copy updated IDL
2. Alerting/logging module (`services/shared/src/alerting.ts`) — shared dependency used by all services below
3. **Navigation scaffold**: Wire route structure into `app/layout.tsx` — add nav links for Portfolio (`/portfolio`), History (`/history`), Market Maker (`/market-maker`). Create empty page shells (`page.tsx` with placeholder content) for each. **This prevents merge conflicts** — parallel page agents fill in their page's content without touching layout or navigation files.

Once gates are complete, the following run in parallel:

Frontend items (parallel with each other and with services). **Parallel safety rule**: Each task writes only to its own page directory and components. No task modifies `layout.tsx`, navigation, or shared layout components — those are locked after gate 3.

**Page ownership** (prevents conflicts on shared pages):
- `app/markets/page.tsx` — **owned by the Onboarding flow task**. This is the only task that modifies the Markets page layout. All other Markets page content (SettlementStatus, oracle prices, payoff display) is delivered as **standalone components in `components/`** that the Onboarding task imports. If the Onboarding task finishes first, it integrates the components; if other component tasks finish first, they leave an import-ready component and the Onboarding task wires it in.
- `app/trade/[ticker]/page.tsx` — **not modified by any Phase 3B task**. Phase 2B already built this page. Phase 3B tasks deliver components (SettlementStatus, payoff, oracle) that are imported by the existing page — edits to the Trade page are a single integration step after all components are ready, not a parallel task.

- [ ] Portfolio page (`app/portfolio/`): active positions, settled outcomes, P&L (entry vs current/exit), redeem buttons, "Cancel & Recover" for unfilled Buy No limit orders
- [ ] History page (`app/history/`): trade execution log sourced from the event indexer (`/api/events/*` proxy routes). Filterable by market, side, and date. Paginated. Falls back to on-the-fly `getSignaturesForAddress` parsing if indexer is unavailable. **Depends on event indexer API contract** (route shape + response schema) but NOT on the indexer being fully operational — frontend can develop against the contract and fall back to direct parsing.
- [ ] **Market Maker dashboard** (`app/market-maker/`): dedicated view for liquidity providers, separate from the Portfolio page. Components: (1) inventory summary — Yes/No token balances across all active markets in a single table, (2) open orders panel with per-market grouping and bulk-cancel button, (3) quick mint+quote workflow — mint pairs for a market and immediately post bid/ask limit orders in one flow, (4) fill history with per-trade P&L and realized/unrealized breakdown, (5) net exposure heatmap — visual grid showing long/short/neutral per ticker×strike. Data sourced from existing `usePortfolio`, `useOrderBook`, and `useMarkets` hooks + a new `useMarketMaker` aggregation hook. This is the spec's "Market Maker — Mint & Quote" user story given first-class treatment rather than being folded into Portfolio. **Mainnet access control**: On devnet, the page is accessible to all connected wallets. On mainnet, gated by wallet allowlist — `NEXT_PUBLIC_MM_WALLETS` env var contains a comma-separated list of approved wallet addresses. The `useNetwork()` hook + a `useMMAccess()` hook check connected wallet against the list; page returns a "Request Access" message for non-listed wallets. This is a **frontend-only gate** — the underlying instructions (`mint_pair`, `place_order`, `cancel_order`) remain permissionless on-chain. The page is a UX convenience for approved LPs, not a security boundary. Allowlist managed via Railway env vars, updatable without redeploy.
- [ ] **Settlement status component** (`components/SettlementStatus.tsx`): standalone component, no page modifications. Consumed by Trade and Markets pages via import. Includes both the settlement countdown timer to 4:00 PM ET AND the override window indicator ("Settlement under review — redemptions available at [time]"). Combined into one task to prevent two parallel agents building overlapping UI for the same data.
- [ ] Payoff display (`components/PayoffDisplay.tsx`): standalone component, no page modifications. Yes side: "You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]." No side: "You pay $X. You win $1.00 if [STOCK] closes below [STRIKE]." Adapts based on trade side.
- [ ] Real-time oracle price display per stock (`components/OraclePrice.tsx`): standalone component, no page modifications. WebSocket subscription to PriceFeed accounts.
- [ ] Transaction status toasts with Solana Explorer links (`components/TxToast.tsx`): standalone component, no page modifications.
- [ ] **Onboarding flow** (`app/markets/page.tsx` — **page owner**): contextual banner for new users (no positions, first visit). 3-step guide: "Fund Wallet → Pick a Market → Place Your First Trade." Each step highlights the relevant UI element. Dismisses permanently after first trade (tracked in `localStorage`). Not a modal wizard — inline nudges that coexist with the real UI. **This task owns the Markets page layout** — it integrates SettlementStatus, OraclePrice, and PayoffDisplay components into the page alongside the onboarding flow.

Services (parallel with each other, except where noted):
- [ ] Oracle feeder service: Tradier streaming → on-chain `update_price` calls
- [ ] Market-initializer service: morning job reads Tradier previous close, calculates strikes, calls `create_strike_market` + creates ALT per market + calls `set_market_alt` to write ALT address on-chain
- [ ] Settlement service: afternoon reads Tradier close, updates oracle, calls `settle_market`, then `crank_cancel` loop. Retry logic (30s × 15min), admin alert on failure. **Note: e2e testing requires oracle feeder to be running** (needs fresh on-chain prices to settle). Build independently, test integration after oracle feeder is operational.
- [ ] Automation scheduler: timed jobs with DST-aware ET conversion using `America/New_York` timezone
- [ ] **Event indexer** (`services/event-indexer/`): Lightweight service that watches for Anchor events (FillEvent, SettlementEvent, cancel, redeem) via `connection.onLogs(programId)` and persists them to a SQLite database (`events.db` via `better-sqlite3`). On startup, backfills from last-processed checkpoint via `getSignaturesForAddress` + log parsing (incremental — not a full rescan). Exposes a REST API (`GET /api/events?market=X&type=fill&limit=50`) consumed by the frontend History page and Settlement Analytics. SQL filtering replaces file scanning — queries are fast regardless of data volume. TanStack Query in the frontend hits `/api/events/*` Next.js proxy routes. On Railway, a 1GB persistent volume mounted at `/data` holds `events.db` — survives redeploys. See "Trade History & Event Storage" section for full schema and deployment details. Indexer runs as a 5th Railway service in both environments.

**Automation service timing (spec requirement):**
- **8:00 AM ET**: Morning job reads previous close from Tradier, calculates strikes (±3/6/9%, $10 rounding, dedup)
- **8:30 AM ET**: Creates contracts + order books + ALTs for each strike. Logs results. Alerts on failure. Retries with backoff.
- **9:00 AM ET**: Markets visible on frontend, minting enabled
- **9:30 AM ET**: US market open, live trading
- **4:00 PM ET**: US market close
- **~4:05 PM ET**: Settlement job reads Tradier closing price, updates oracle, calls `settle_market`. If oracle confidence too wide, retries every 30 seconds for up to 15 minutes. If still failing, alerts admin for manual override.
- **~4:06 PM ET**: `crank_cancel` loop clears all resting orders, returns escrow to owners.
- **4:05–5:05 PM ET**: Override window. Admin can call `admin_override_settlement` if oracle price was incorrect. Redemptions blocked. Frontend shows "Settlement under review."
- **~5:05 PM ET+**: Override window expires. Outcome truly final. Redemption enabled.

**Stage 3C — Tests (bankrun for on-chain, vitest for frontend)**

On-chain tests (parallel with each other):
- [ ] Settlement: at-strike (Yes wins, >= rule), above-strike (Yes wins), below-strike (No wins)
- [ ] Oracle validation: stale price rejected (>120s), wide confidence rejected (>0.5%), valid price accepted
- [ ] `admin_settle`: delay enforced (1hr after market close), succeeds after delay, fails if already settled
- [ ] `admin_override_settlement`: requires `is_settled == true`, succeeds within window, fails after deadline, flips outcome correctly, resets deadline, increments `override_count`, fails with `MaxOverridesExceeded` after 3 overrides
- [ ] `redeem` winner/loser mode blocked during override window (`RedemptionBlockedOverride`), succeeds immediately after deadline passes
- [ ] `redeem` pair burn mode succeeds during override window (outcome-independent, not blocked)
- [ ] `crank_cancel` succeeds during override window (escrow refunds are outcome-independent)
- [ ] Admin overrides outcome during window → post-deadline `redeem` pays based on corrected outcome, not original
- [ ] Admin override count: first 3 overrides succeed, 4th fails with `MaxOverridesExceeded` even if deadline hasn't passed
- [ ] `crank_cancel` mid-flight during admin override → crank unaffected (returns same assets regardless of outcome flip)
- [ ] Pair burn during override, then admin flips outcome: user A pair-burns during override window (gets $1), admin flips outcome, user B redeems after deadline — user B's payout reflects corrected outcome, vault balance is consistent (`total_minted - total_redeemed` accounts for both the pair burn and the redemption)
- [ ] `admin_override_settlement` fails with `MaxOverridesExceeded` after 3 overrides — outcome is final regardless of deadline
- [ ] Redeem: winning tokens paid $1, losing tokens zeroed, vault empties after full redemption
- [ ] Redeem Yes+No pair burn: burns both for $1 USDC, works pre-settlement (no `is_settled` requirement), works during override window
- [ ] `crank_cancel`: batch processing (32 slots), skip inactive, reject unsettled market, returns 0 when empty
- [ ] Manual `cancel_order` still works post-settlement alongside crank
- [ ] Add strike intraday: `create_strike_market` callable by admin anytime, PDA prevents duplicates
- [ ] Pause/unpause: global and per-market, already paused / not paused errors
- [ ] Invariants: vault balance = total_minted - total_redeemed, Yes supply = No supply

Integration tests (sequential — these exercise the full pipeline):
- [ ] Full lifecycle e2e: create → mint → trade → settle → crank_cancel → redeem (vault empties to zero)
- [ ] Multi-user: maker mints/quotes, taker fills, both redeem correctly
- [ ] Settlement executes within 10 minutes of market close (success criterion)

Service tests (vitest — parallel with on-chain and frontend tests):
- [ ] Event indexer: log parser correctly extracts FillEvent/SettlementEvent from Anchor program logs, incremental backfill resumes from checkpoint on restart (not full rescan), REST API returns correct filtered/paginated results, SQLite persistence writes and reads correctly (atomic transactions, no partial writes), handles malformed logs gracefully

Frontend tests (vitest — parallel with on-chain tests):
- [ ] Real-time price display from oracle (mock `onAccountChange`, verify re-render)
- [ ] Portfolio + P&L accuracy
- [ ] Settlement display + override window + redeem flow
- [ ] History page: renders trade log from event indexer API, handles indexer-down fallback (direct tx parsing), pagination
- [ ] Market Maker dashboard: `useMarketMaker` aggregation hook (inventory across markets, open order grouping), `useMMAccess` access control (allowed wallet passes, blocked wallet sees "Request Access"), quick mint+quote workflow validation, net exposure heatmap calculation

**Stage 3D — Audit**
Run `/audit` against all Phase 3 code. Verify:
- Settlement logic: >= rule correct, immutable after override window, oracle validation tight
- Override: outcome flip is correct (winners become losers and vice versa)
- Redemption: winner/loser mode blocked during override window, unblocked after; pair burn mode works anytime (pre-settlement, during override window)
- Crank: no fund leaks, skips inactive correctly, compatible with manual cancel
- Automation: retry logic correct, timezone handling (DST), alert on failure
- Invariants hold across entire lifecycle (vault, supply, payout sum)
- Unredeemed tokens remain redeemable indefinitely
- Fee handling: this system charges **zero fees** — no trading fees, no minting fees, no redemption fees. The vault holds only collateral ($1 × pairs minted). No fee logic exists anywhere in the codebase.

**Demo checkpoint**: Full daily lifecycle works end-to-end on devnet. Settlement via Tradier data. Crank clears book. Winners redeem.

---

### Phase 3.5: Complexity Sweep
Run `/complexity-sweep` across entire codebase (Phases 1–3). Focus areas:
- Rust: 13 instructions now complete (3 more in Phase 6: `close_market`, `treasury_redeem`, `cleanup_market`) — scan for duplicated validation logic across handlers (should be extracted to shared `validate_market_active()`, `validate_oracle()` helpers)
- Settlement + override + crank interaction: are the state transitions clean, or is there spaghetti between `is_settled`, `outcome`, `override_deadline`?
- Services: oracle feeder, market initializer, settlement service — flag shared logic that should live in `services/shared/`
- Frontend: full app now has Markets, Trade, Portfolio, History pages + multiple hooks — flag prop drilling, duplicated data fetching, components that grew beyond 150 lines
- Test files: split any test file > 300 lines by scenario group
- This is the last sweep before differentiator features — the core must be clean and modular before we add 6 new features on top.

---

### Phase 4: Differentiator Features
**Goal**: All 6 differentiators operational. These go beyond spec requirements.

**Stage 4A — Gate → parallel: all 6 features**
All depend on Phase 3 being complete (including oracle feeder running for AMM bot price reads), but not on each other.

Gate (must complete before parallel feature work):
1. **Shared analytics utilities**: Create `app/meridian-web/src/lib/tradier-proxy.ts` — shared Tradier API proxy wrapper with 60s TTL caching, rate limiting, and error fallback. All `/api/tradier/*` routes consume from it (single pattern for quotes, options, history). Also create `app/meridian-web/src/hooks/useAnalyticsData.ts` — shared hook for fetching/caching Tradier + event indexer data, and `app/meridian-web/src/lib/chartConfig.ts` — shared chart styling/theme constants. **This prevents 4 analytics components from independently inventing their own data-fetching and charting patterns.**

Once gate is complete, the following run in parallel:
- [ ] **Vol-aware strikes** (`services/market-initializer/src/strikeSelector.ts`): HV20 from 60-day Tradier history → 1/1.5/2 sigma strike levels. Enhancement to spec's baseline ±3/6/9%. Both available; vol-aware default, baseline fallback.
- [ ] **AMM bot** (`services/amm-bot/`): Black-Scholes binary pricer (N(d2) formula), inventory skew, circuit breaker, configurable spread. Seeds liquidity so demo has live tradeable markets. Uses existing `place_order`/`cancel_order`. **Prerequisite: oracle feeder (Phase 3B) must be operational** — bot reads on-chain oracle prices for its pricing model. Bot's pricer logic is pure and testable independently; e2e testing requires oracle prices on-chain.
- [ ] **Options comparison** (`app/meridian-web/src/components/analytics/OptionsComparison.tsx`): Tradier options chain (greeks=true) delta at each strike vs Meridian Yes price side-by-side ("Options market says 62%, Meridian says 58%"). Data via `/api/tradier/options` route (uses shared `tradier-proxy.ts`). **Fallback UX**: if Tradier API returns empty options chain (no 0DTE expiry for this ticker, or outside market hours), show "Options data unavailable" with explanation — never render stale or missing data as zeros.
- [ ] **Historical overlay** (`app/meridian-web/src/components/analytics/HistoricalOverlay.tsx`): 252-day daily return distribution from Tradier overlaid on current Yes token probabilities across strikes. Data via `/api/tradier/history` route (uses shared `tradier-proxy.ts`). **Fallback UX**: if Tradier history returns fewer than 60 trading days (new listing, data gap), show partial distribution with "Limited data — N days available" disclaimer.
- [ ] **Settlement analytics** (`app/meridian-web/src/components/analytics/SettlementAnalytics.tsx`): calibration chart (implied prob bucket vs realized frequency), accuracy tracking, leaderboard. Data from event indexer API (`/api/events?type=settlement`).
- [ ] **Binary Greeks** (`app/meridian-web/src/components/analytics/GreeksDisplay.tsx`): binary delta = N'(d2)/(S*sigma*sqrt(T)), binary gamma. Displayed per market, updated from live Tradier price feed. Math in `lib/greeks.ts` (already exists from Phase 1B — this task is the React component only).

**Parallel safety rule**: Each analytics component writes only to its own `.tsx` file in `components/analytics/`. Shared utilities (`tradier-proxy.ts`, `useAnalyticsData.ts`, `chartConfig.ts`) are locked after the gate. Tradier API route files (`/api/tradier/options/route.ts`, `/api/tradier/history/route.ts`) are each owned by exactly one component task (options → OptionsComparison, history → HistoricalOverlay).

**Stage 4B — Tests**
- [ ] HV calculation: known inputs → known outputs
- [ ] Binary pricer: boundary conditions (ATM, deep ITM, deep OTM, T=0, T=tiny)
- [ ] Strike selector: sigma-based strikes produce reasonable levels for various price/vol combos
- [ ] AMM bot: inventory limit enforcement, circuit breaker triggers, spread calculation
- [ ] Greeks: binary delta/gamma values match known formulas at boundary conditions
- [ ] Options comparison: Tradier options chain data correctly fetched and parsed, delta-to-probability mapping matches expected values, side-by-side rendering with Meridian prices
- [ ] Historical overlay: 252-day return distribution correctly calculated from Tradier OHLCV data, distribution overlay renders with correct probability buckets aligned to strike prices
- [ ] Settlement analytics: calibration chart buckets implied probabilities correctly, accuracy percentage calculated from settlement records, leaderboard sorts by P&L

**Stage 4C — Audit**
Run `/audit` against all Phase 4 code. Verify:
- Math functions: edge cases handled (division by zero, T=0, extreme vol)
- AMM bot: circuit breaker actually halts, inventory limits enforced
- API routes: Tradier calls go through proxy only, cached appropriately (60s TTL)
- No regressions in Phase 1-3 functionality

**Demo checkpoint**: All 6 differentiator features visible and functional in frontend.

---

### Phase 4.5: Complexity Sweep
Run `/complexity-sweep` across entire codebase (Phases 1–4). Focus areas:
- 6 new feature modules just landed — scan for inconsistent patterns across analytics components (should share data-fetching conventions, chart styling, error handling)
- AMM bot: pricer → quoter → executor pipeline — clean separation or tangled?
- Tradier API routes: are all 3 routes (quotes, options, history) following the same proxy + cache pattern?
- `lib/` pure functions: `greeks.ts`, `volatility.ts`, `strikes.ts` — any duplication or functions that grew beyond 40 lines?
- This is the final sweep before polish — any complexity issues found here get fixed before we write docs and CI, so the codebase we ship is clean.

---

### Phase 5: Polish
**Goal**: Demo-ready. Clean README, reproducible scripts, CI green.

**Stage 5A — Parallel: docs + polish (independent of each other)**
- [ ] Landing page: product explanation, "How it works" 3-step visual (Fund → Trade → Settle), live market summary (tickers, active strikes, current prices — visible without connecting wallet), connect wallet CTA. Not just a splash — a real preview of what's inside.
- [ ] README: finalize with one-command setup (`make dev`), prerequisites, architecture overview, testing instructions. Add "Deploy to Railway" section (see Deployment below).
- [ ] `.env.example`: verify all required variables present (see Environment Variables section)
- [ ] Architecture doc: chain choice rationale, custom order book design, oracle strategy, trade-offs
- [ ] HyperLiquid feasibility note (see `docs/DEV_LOG.md` for content — extract to standalone doc)
- [ ] Risks/limitations note — must include known technical limitations, trust assumptions, and economic edge cases. **Must NOT make any regulatory or compliance claims** (per spec: "no regulatory or compliance claims"). State that the system is a prototype and does not constitute a regulated financial product. Do not assert compliance with SEC, CFTC, or any other regulatory body.
- [ ] Dependency justification doc (see `docs/DEV_LOG.md` for table — extract to standalone doc)
- [ ] CI workflows (GitHub Actions, `.github/workflows/ci.yml`):
  - **Anchor tests job**: Install Rust 1.94, Solana CLI 2.1, Anchor CLI 0.30.1. Run `anchor build`, then `anchor test` (bankrun, no validator needed). Cache `~/.cargo` and `target/` across runs.
  - **Frontend job**: Install Node 18, Yarn. Run `yarn install --frozen-lockfile`, `yarn lint` (ESLint), `yarn typecheck` (tsc --noEmit), `yarn test` (Vitest). Working directory: `app/meridian-web/`.
  - **Services job**: Install Node 18, Yarn. Run lint + typecheck + unit tests for `services/oracle-feeder/`, `services/amm-bot/`, `services/market-initializer/`, `services/event-indexer/`, `services/shared/`.
  - **Triggers**: push to `main`, pull requests to `main`. All three jobs run in parallel.
- [ ] **Railway deployment config**: Single Railway project, `devnet` environment (Phase 5). `mainnet` environment added in Phase 6.
  - 5 services per environment: `meridian-web`, `oracle-feeder`, `market-initializer`, `amm-bot`, `event-indexer`.
  - `meridian-web` — Next.js frontend + faucet API routes. Root: `app/meridian-web/`. Build: `yarn build`, Start: `yarn start`.
  - `oracle-feeder` — long-running WebSocket process. Root: `services/oracle-feeder/`.
  - `market-initializer` — scheduled morning + afternoon jobs. Root: `services/market-initializer/`.
  - `amm-bot` — long-running liquidity bot. Root: `services/amm-bot/`.
  - `event-indexer` — long-running log watcher + REST API for trade history. Root: `services/event-indexer/`. 1GB persistent volume mounted at `/data` for SQLite DB.
  - Shared env vars across all services via Railway project variables. `FAUCET_KEYPAIR` (USDC mint authority, base58) set only on `meridian-web` in `devnet` env.
  - `railway.toml` per service with build/start commands + health check paths.
  - `devnet` env deploy trigger: push to `main`. `mainnet` env deploy trigger: push to `release` (Phase 6).
  - See Infrastructure → Deployment for full environment matrix.

**Stage 5B — Sequential: validation (once 5A is complete)**
These depend on 5A outputs (README, CI, scripts) and on each other.
1. Idempotent `deploy-devnet.sh` — verify reproducible from clean clone. **Idempotence rules**: `anchor deploy` uses `--program-keypair` for stable program IDs across redeploys; `create-mock-usdc.ts` checks if mint exists before creating; `init-config.ts` catches `ConfigAlreadyInitialized` and skips; `init-oracle-feeds.ts` catches `OracleFeedAlreadyInitialized` per ticker and skips; `create-test-markets.ts` catches `AccountAlreadyInUse` per market and skips. Script exits 0 on full or partial skip (already-initialized state is success).
2. Load test: 100 simulated orders across 5 markets on devnet using **5+ distinct wallets** (not single-wallet — validates multi-user matching, cross-wallet escrow, and concurrent ATA creation). Needs deploy to succeed first. **Success criteria**: all 100 orders land on-chain without CU exhaustion, no vault invariant violations, order book state consistent after all fills, settlement completes for all 5 markets, crank_cancel clears all resting orders, all wallets can redeem correctly, event indexer captures all fill/settle/redeem events (query API and verify count matches on-chain activity), total test completes within 10 minutes.

**Stage 5C — Final Audit**
Run `/audit` against entire codebase. Verify:
- All 13 core instructions correct and tested (3 Phase 6 instructions tested separately)
- All error codes used and mapped to frontend messages
- All invariants hold under full lifecycle
- No secrets in repo (.env gitignored, .env.example has placeholders only)
- No dead code, no commented-out code
- README `make dev` works from clean clone
- CI green
- Load test passes

**Demo checkpoint**: Full system demo-ready. Clean clone → `make dev` → working prototype.

---

### Phase 6: Mainnet Deployment (Bonus)
**Goal**: Full system running on Solana mainnet-beta with real infrastructure. Real USDC, production oracle feeds, funded automation wallet, monitoring.

> **Note**: The spec requires 8 smart contract functions. Phases 1–3 deliver 13 instructions covering all spec requirements plus `set_market_alt`, `crank_cancel`, `admin_override_settlement`, `pause`, and `unpause`. Phase 6 adds 3 more instructions (`close_market`, `treasury_redeem`, `cleanup_market`) for mainnet sustainability — these are beyond spec scope and not required for the devnet prototype.

**Prerequisites (manual, before any Stage 6 work):**
- [ ] Generate dedicated mainnet keypair: `solana-keygen new -o ~/.config/solana/mainnet-deployer.json` — never reuse devnet key
- [ ] Fund mainnet keypair with ~100 SOL (program deploy ~5 SOL, account rent ~75 SOL for 49 markets — dominated by ~0.877 SOL per OrderBook account at ~125 KB each, automation tx fees ~0.1 SOL/day). Market initializer script should validate sufficient SOL balance before creating markets.
- [ ] Sign up for Helius RPC (helius.dev, free tier = 50 RPS) — mainnet public RPC is too rate-limited
- [ ] Set up monitoring endpoint (Discord webhook for alerts — simplest path)

**Stage 6A — Gate → two parallel tracks: oracle swap + market closure (funds-critical)**

Pyth and market closure are independent features that touch different instructions. They share only the error codes and the `is_closed` schema field, which are done first as a gate.

```
error codes + is_closed field (gate)
  ↓
┌──────────────────────────┐  ┌──────────────────────────────────────────────┐
│ Track A: Pyth oracle     │  │ Track B: market closure (sequential chain)   │
│ (independent)            │  │ close_market → treasury_redeem → cleanup     │
└──────────────────────────┘  └──────────────────────────────────────────────┘
```

Gate (must complete before both tracks):
1. Add `is_closed: bool` field to StrikeMarket schema (takes 1 byte from existing padding).
2. Add `MarketClosed` (6025) constraint checks to existing instructions: `mint_pair`, `place_order`, `settle_market`, and standard `redeem` must all reject with `MarketClosed` when `is_closed == true`. Users of partially-closed markets must use `treasury_redeem` instead.
3. Error codes: add all Phase 6 codes to `error.rs` (these are the same codes documented in the Error Codes reference section below — listed here so the gate step is self-contained):
   Market closure errors:
   - `6110 CloseMarketNotSettled` — market not settled
   - `6111 CloseMarketOverrideActive` — override window still open
   - `6112 CloseMarketOrderBookNotEmpty` — resting orders remain
   - `6113 CloseMarketGracePeriodActive` — tokens unredeemed and < 90 days post-settlement
   - `6116 MarketNotClosed` — `treasury_redeem` or `cleanup_market` on a market that isn't partially closed
   - `6117 MintSupplyNotZero` — `cleanup_market` called but tokens still outstanding
   - `6118 NoTreasuryFunds` — treasury has insufficient USDC to cover redemption
   Oracle type errors (used by Track A — Pyth integration):
   - `6114 InvalidOracleType` — oracle type flag not recognized
   - `6115 PythFeedMismatch` — Pyth price feed ID doesn't match expected stock

**Track A** (independent — can run in parallel with Track B):
- [ ] **Pyth oracle integration**: Replace mock oracle CPI with Pyth `PriceUpdateV2` account reads.
   - Feature-flagged dual path in `settle_market` — reads mock oracle on devnet, Pyth on mainnet. Selected by `oracle_type` field in GlobalConfig (0=Mock, 1=Pyth).
   - Pyth account validation: check price feed ID matches expected stock, verify status is `Trading`, apply same staleness (120s) and confidence (0.5% bps) thresholds.
   - **Test with Pyth devnet feeds first** before mainnet. Pyth has limited equity coverage — verify all 7 MAG7 tickers are available. If any are missing, keep mock oracle as fallback for those tickers.
   - **Parallel safety rule**: Track A modifies ONLY `instructions/settle_market.rs` (adding Pyth code path). Track A must NOT touch `StrikeMarket.is_closed`, `instructions/close_market.rs`, `instructions/treasury_redeem.rs`, or `instructions/cleanup_market.rs` — those belong exclusively to Track B. The only shared touchpoint is the gate (error codes + `is_closed` field), which is complete before either track starts.

**Track B** (sequential — each instruction depends on the prior):
1. **`close_market` instruction (#14)**: Admin-only. Partial close — reclaims ~98% of rent while preserving settlement record for late claims.
   - Preconditions: market settled, override window expired, order book empty (crank_cancel completed)
   - **Standard close** (`total_redeemed == total_minted`): Closes all 8 accounts (OrderBook, USDC Vault, Escrow Vault, Yes Escrow, No Escrow, StrikeMarket, Yes Mint, No Mint). Full rent reclaim. Market leaves zero on-chain footprint.
   - **Partial close** (90+ days post-settlement, tokens remain): `Clock >= settled_at + 7_776_000` (90 days).
     - Closes 5 accounts: OrderBook (~125KB, ~0.89 SOL), USDC Vault, Escrow Vault, Yes Escrow, No Escrow. Rent returned to admin.
     - Keeps 3 accounts: StrikeMarket (~0.003 SOL), Yes Mint (~0.002 SOL), No Mint (~0.002 SOL). These serve as permanent settlement record for `treasury_redeem`.
     - Revokes mint authority on both Yes and No mints (no new tokens can ever be created).
     - Sweeps remaining vault USDC to TreasuryPDA (`[b"treasury"]`).
     - Sets `is_closed: bool` on StrikeMarket — marks market as partially closed, vault funds in treasury.
   - TreasuryPDA is created during `initialize_config` (Phase 1). Derived at runtime from `[b"treasury"]` seeds.
2. **`treasury_redeem` instruction (#15)**: Permissionless. No time limit. Late-claim path for users who missed the 90-day vault window.
   - User passes Yes/No tokens + the still-existing StrikeMarket account.
   - Requires `StrikeMarket.is_closed == true` (only for partially-closed markets; standard `redeem` handles live markets).
   - Program reads outcome from StrikeMarket.
   - Burns winning tokens → pays $1 USDC per token from Treasury PDA.
   - Burns losing tokens → $0 (just burns them, cleaning up supply).
   - Available indefinitely. Users always have a path to claim.
3. **`cleanup_market` instruction (#16)**: Admin-only. Final cleanup once all tokens are burned.
   - Requires `StrikeMarket.is_closed == true`.
   - Requires Yes Mint supply == 0 AND No Mint supply == 0 (all tokens burned via `treasury_redeem` or voluntary burn).
   - Closes remaining 3 accounts: StrikeMarket, Yes Mint, No Mint.
   - Returns final ~0.007 SOL rent to admin.
   - Market now has zero on-chain footprint.
   - If supply never reaches 0 (lost wallets, dust): these accounts stay open at ~0.007 SOL indefinitely. Acceptable cost — see DEV_LOG for rationale.

**Stage 6B — Parallel: mainnet deployment infra (once both 6A tracks are complete)**
All depend on 6A being tested on devnet, but not on each other.
- [ ] `scripts/deploy-mainnet.sh`: Idempotent mainnet deployment script. Uses `~/.config/solana/mainnet-deployer.json`. Sets cluster to mainnet-beta. Deploys both programs. Runs init with real USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), `oracle_type = 1` (Pyth). Initializes Pyth-backed oracle config.
- [ ] `.env.mainnet.example`: Mainnet env vars — Helius RPC URL, mainnet deployer keypair path, real USDC mint, Pyth program ID, Tradier production API key.
- [ ] Monitoring service (`services/monitor/`): Lightweight health checker running on a cron or loop:
  - Automation wallet SOL balance (alert if < 1 SOL)
  - Oracle freshness per ticker (alert if stale > 5 min during market hours)
  - Settlement job completion (alert if any market unsettled 15 min after close)
  - Failed transaction alerts (parse recent tx for errors)
  - Output: Discord webhook notifications. Configurable via `DISCORD_WEBHOOK_URL` env var.
- [ ] Program upgrade authority transfer: Script to transfer upgrade authority from deployer to a Squads multisig. Optional — can also revoke with `solana program set-upgrade-authority --final` once stable. Document both paths in README.
- [ ] Rent budget calculator: Script that estimates total rent cost for N stocks × M strikes × D days. Outputs SOL needed. Helps plan wallet funding.
- [ ] `close_market` automation: Extend settlement service to run a daily sweep — find markets > 90 days post-settlement with unredeemed tokens, call `close_market` (partial), log results. Also run `cleanup_market` for any partially-closed markets where mint supply has reached 0. **Treasury balance safety**: before sweeping, verify treasury balance can cover all pending `treasury_redeem` claims (sum of `total_minted - total_redeemed` across all partially-closed markets). If the treasury would be underfunded after the sweep, alert admin and skip. Process `treasury_redeem` claims before new `close_market` sweeps when possible.
- [ ] Frontend: "Market closing in X days" warning for markets approaching 90-day deadline. Post-close: "Redeem via treasury" flow using `treasury_redeem`.
- [ ] **Network-aware UI layer**: All UX differences between devnet and mainnet driven by `NEXT_PUBLIC_SOLANA_NETWORK` env var. No code forks — conditional rendering based on a single `useNetwork()` hook.
  - **Header badge**: "Devnet" (green) or "Mainnet" (orange) — always visible so users know which network they're on.
  - **Faucet visibility**: SOL/USDC faucet buttons shown on devnet, hidden on mainnet.
  - **Trade confirmation (mainnet only)**: Modal before every trade: "You are spending **X.XX USDC** (real money). This transaction is irreversible." Explicit "Confirm Trade" button. Not shown on devnet — would slow down testing.
  - **Wallet funding guide (mainnet only)**: Replaces the faucet prompt for zero-balance users. "How to Fund Your Wallet" page/modal with steps: (1) Buy SOL from Coinbase/Kraken, (2) Transfer to your Phantom wallet, (3) Swap SOL → USDC on Jupiter. Links to each platform. Phantom's built-in on-ramp (MoonPay) as alternative one-step path.
  - **Onboarding copy divergence**: Devnet 3-step guide: "Get Free SOL → Get Free USDC → Place Your First Trade." Mainnet 3-step guide: "Fund Your Wallet → Browse Markets → Place Your First Trade."
  - **Explorer links**: Devnet tx links → `explorer.solana.com/?cluster=devnet`. Mainnet tx links → `explorer.solana.com` (default mainnet).
  - **Risk disclaimer (mainnet only)**: Footer text: "Meridian uses real USDC on Solana mainnet. Trade only what you can afford to lose." Shown on every page.
- [ ] **Railway mainnet environment**: Set up `mainnet` environment in Railway project with production env vars (Helius RPC, real USDC mint, Pyth program ID, mainnet deployer keypair). Deploy from `release` branch. Separate domain from devnet.

**Stage 6C — Tests (parallel with each other)**
- [ ] Pyth oracle: valid price read, stale price rejected, wide confidence rejected, wrong feed ID rejected, `Trading` status required
- [ ] Pyth + settlement e2e: create market → trade → settle via Pyth → redeem (on devnet with Pyth devnet feeds)
- [ ] `close_market` standard: all tokens redeemed → all 8 accounts closed, full rent returned
- [ ] `close_market` partial: 90 days elapsed, tokens remain → 5 accounts closed (OrderBook + USDC Vault + Escrow Vault + Yes Escrow + No Escrow), 3 kept, vault swept to treasury, mint authority revoked
- [ ] `close_market` rejected: not settled, override active, book not empty, grace period active (all 4 error paths)
- [ ] `treasury_redeem`: winning tokens pay $1 from treasury, losing tokens burn for $0, rejects if market not closed
- [ ] `treasury_redeem` with insufficient treasury funds: clear error, no partial payout
- [ ] `cleanup_market`: closes remaining 3 accounts when supply = 0, rejects when supply > 0
- [ ] Full closure lifecycle: close_market (partial) → treasury_redeem (all users) → cleanup_market → zero accounts
- [ ] Treasury PDA: receives swept funds correctly, balance accumulates across multiple partial closes, decreases on treasury_redeem
- [ ] Mainnet deploy script: dry-run mode that validates all accounts exist without submitting transactions
- [ ] Monitor: mock alert triggers, verify Discord webhook format

**Stage 6D — Audit**
Run `/audit` against all Phase 6 code. Verify:
- Pyth integration: no mock oracle assumptions leak into mainnet path
- `close_market`: all preconditions enforced, no fund leaks, rent correctly reclaimed, mint authority revoked
- `treasury_redeem`: outcome read correctly from StrikeMarket, payout math correct, treasury balance decremented
- `cleanup_market`: only succeeds at supply 0, closes all remaining accounts
- Treasury sweep: exact USDC amount matches vault remainder
- Mainnet script: uses correct USDC mint, correct Pyth program, correct keypair
- No devnet-only assumptions in any shared code (hardcoded URLs, mock mints, test keypairs)
- Upgrade authority documented: transfer or revoke instructions in README

**Demo checkpoint**: Programs deployed on mainnet-beta. Real USDC markets created for today's MAG7 strikes. Oracle fed by Tradier → Pyth (or mock oracle on mainnet if Pyth coverage gaps). Settlement runs at 4 PM ET. Monitoring alerts to Discord. Full closure lifecycle tested on devnet with simulated 90-day-old markets: close_market → treasury_redeem → cleanup_market.

---

### Execution Model

- **Opus (me)**: all sequential stages (funds-critical logic), synthesis, integration, audit review
- **Parallel agents**: all parallel stage tasks — each agent gets one module with clear inputs/outputs/tests
- **Rule**: no agent touches matching engine, escrow, settlement, override, crank, or PDA seeds. Those are sequential-only.

---

## Error Codes (Anchor `#[error_code]` enum in `error.rs`)

Comprehensive error handling is non-negotiable — when money is involved, trust depends on every failure mode producing a clear, specific error. No generic panics, no silent failures. Every error maps to a user-friendly message in `frontend/lib/errors.ts`.

### Authorization & Access Control
| Code | Name | Trigger |
|---|---|---|
| 6000 | `Unauthorized` | Non-admin calling admin-only instruction |
| 6001 | `InvalidAuthority` | Oracle update from non-authority wallet |
| 6002 | `SignerMismatch` | Transaction signer doesn't match expected account owner |

### Initialization & Configuration
| Code | Name | Trigger |
|---|---|---|
| 6010 | `ConfigAlreadyInitialized` | `initialize_config` called twice |
| 6011 | `OracleFeedAlreadyInitialized` | `initialize_feed` for same ticker twice |
| 6012 | `InvalidTicker` | Ticker not in `GlobalConfig.tickers` list |
| 6013 | `InvalidMarketCloseTime` | `market_close_unix` is in the past |
| 6014 | `InvalidStrikePrice` | Strike price is 0 |
| 6015 | `InvalidStalenessThreshold` | Staleness threshold set to 0 |
| 6016 | `InvalidConfidenceThreshold` | Confidence bps set to 0 or > 10000 |

### Market State
| Code | Name | Trigger |
|---|---|---|
| 6020 | `MarketAlreadySettled` | Trade/mint on a settled market |
| 6021 | `MarketNotSettled` | `crank_cancel`, `redeem`, or `admin_override_settlement` on unsettled market |
| 6022 | `MarketPaused` | Trade/mint while market or global is paused |
| 6023 | `AlreadyPaused` | `pause` on already-paused target |
| 6024 | `NotPaused` | `unpause` on non-paused target |
| 6025 | `MarketClosed` | Operation attempted on a partially-closed market (`is_closed == true`). Blocks `mint_pair`, `place_order`, `settle_market`, and standard `redeem` — user must use `treasury_redeem` instead. |

### Account Validation
| Code | Name | Trigger |
|---|---|---|
| 6030 | `InvalidMint` | Token account mint doesn't match expected Yes/No/USDC mint |
| 6031 | `InvalidVault` | Vault account doesn't match market's stored vault address |
| 6032 | `InvalidEscrow` | Escrow account doesn't match market's stored escrow address |
| 6033 | `InvalidOrderBook` | Order book account doesn't match market's stored order book |
| 6034 | `InvalidMarket` | Market PDA doesn't match order book's stored market ref |
| 6035 | `AccountNotInitialized` | Required account has not been initialized |
| 6036 | `InvalidProgramId` | CPI target doesn't match expected program (oracle, token) |

### Oracle
| Code | Name | Trigger |
|---|---|---|
| 6040 | `OracleStale` | Price age > staleness threshold (60s general / 120s settlement) |
| 6041 | `OracleConfidenceTooWide` | Confidence > `confidence_bps` of price |
| 6042 | `OracleNotInitialized` | `PriceFeed.is_initialized == false` |
| 6043 | `OraclePriceInvalid` | Oracle price is 0 or negative-equivalent |
| 6044 | `OracleProgramMismatch` | Oracle program ID doesn't match `GlobalConfig.oracle_program` |

### Trading & Order Book
| Code | Name | Trigger |
|---|---|---|
| 6050 | `InsufficientBalance` | User can't cover order cost or mint deposit |
| 6051 | `OrderBookFull` | All 16 slots at price level are active |
| 6052 | `InvalidPrice` | Price outside [1, 99] range |
| 6053 | `InvalidQuantity` | Quantity < 1_000_000 (minimum 1 token) |
| 6054 | `OrderNotFound` | `cancel_order` with bad price_level/order_id combo |
| 6055 | `OrderNotOwned` | Attempting to cancel someone else's order |
| 6056 | `NoFillsAvailable` | Market order with empty opposite side |
| 6057 | `InvalidOrderType` | Order type not Market or Limit |
| 6058 | `InvalidSide` | Side not 0 (USDC bid), 1 (Yes ask), or 2 (No-backed bid) |
| 6059 | `ConflictingPosition` | `mint_pair` when user holds Yes tokens, or `place_order` side=0 when user holds No tokens |

### Balance & Token Operations
| Code | Name | Trigger |
|---|---|---|
| 6060 | `VaultBalanceMismatch` | Vault balance doesn't match `total_minted - total_redeemed` (invariant violation) |
| 6061 | `MintSupplyMismatch` | Yes mint supply != No mint supply after operation (invariant violation) |
| 6062 | `InsufficientVaultBalance` | Vault can't cover redemption payout |
| 6063 | `TokenTransferFailed` | SPL token transfer CPI returned error |
| 6064 | `TokenMintFailed` | SPL token mint_to CPI returned error |
| 6065 | `TokenBurnFailed` | SPL token burn CPI returned error |
| 6066 | `ATACreationFailed` | Associated token account init_if_needed failed |

### Settlement
| Code | Name | Trigger |
|---|---|---|
| 6070 | `SettlementTooEarly` | `Clock < market_close_unix` |
| 6071 | `AdminSettleTooEarly` | `Clock < market_close_unix + 3600` |
| 6072 | `OverrideWindowExpired` | `admin_override_settlement` after `override_deadline` |
| 6073 | `AlreadySettled` | `admin_settle` on already-settled market |
| 6074 | `InvalidOutcome` | Outcome value not 0, 1, or 2 |
| 6075 | `MaxOverridesExceeded` | `admin_override_settlement` called but `override_count >= 3` — no more overrides allowed |

### Redemption
| Code | Name | Trigger |
|---|---|---|
| 6080 | `RedemptionBlockedOverride` | `redeem` winner/loser mode during override window (1hr post-settlement). Does not apply to pair burn mode. |
| 6081 | `NoTokensToRedeem` | User has 0 balance of relevant tokens |
| 6082 | `InvalidRedemptionMode` | Not winner-redeem, loser-redeem, or pair-redeem |

### Crank
| Code | Name | Trigger |
|---|---|---|
| 6090 | `CrankNotNeeded` | `crank_cancel` called but book is already empty |

### Arithmetic Safety
| Code | Name | Trigger |
|---|---|---|
| 6100 | `ArithmeticOverflow` | Explicit `checked_mul`/`checked_add`/`checked_sub` failure |
| 6101 | `DivisionByZero` | Explicit `checked_div` with zero divisor |

### Market Closure (Phase 6)
| Code | Name | Trigger |
|---|---|---|
| 6110 | `CloseMarketNotSettled` | `close_market` on unsettled market |
| 6111 | `CloseMarketOverrideActive` | `close_market` while override window is open |
| 6112 | `CloseMarketOrderBookNotEmpty` | `close_market` with resting orders (crank_cancel not finished) |
| 6113 | `CloseMarketGracePeriodActive` | Partial close attempted before 90 days post-settlement |
| 6116 | `MarketNotClosed` | `treasury_redeem` or `cleanup_market` on a market that isn't partially closed |
| 6117 | `MintSupplyNotZero` | `cleanup_market` called but tokens still outstanding |
| 6118 | `NoTreasuryFunds` | Treasury has insufficient USDC to cover `treasury_redeem` payout |

### Oracle Type (Phase 6)
| Code | Name | Trigger |
|---|---|---|
| 6114 | `InvalidOracleType` | Oracle type flag in GlobalConfig not recognized |
| 6115 | `PythFeedMismatch` | Pyth price feed ID doesn't match expected stock ticker |

**Design rules:**
- Every error has a unique code — no code reuse across categories
- Category ranges (6000s auth, 6010s init, 6020s state, etc.) leave room for additions
- Invariant violations (6060-6061) should **never** fire in production — they exist as defense-in-depth assertions. If they do fire, something is fundamentally broken.
- Frontend `errors.ts` maps every code to a user-friendly message: e.g. `6050 → "Insufficient USDC balance. Please add funds and try again."`
- All errors are logged with full context (market, user, amounts) in transaction logs via `msg!()` before returning the error

---

## IDL Strategy

Anchor IDL JSON is the program's public interface — version-controlled, not generated at build time.

- `anchor build` generates IDL to `target/idl/meridian.json` and `target/idl/mock_oracle.json`
- Post-build script copies IDL to `app/meridian-web/src/idl/` and `services/shared/src/idl/`
- IDL files are committed to the repo — any instruction or account change shows up as a diff in code review
- Frontend and services import IDL directly: `import idl from '@/idl/meridian.json'`
- `make idl` target runs build + copy

---

## Makefile Targets

```makefile
# Build & Quality
make build        # anchor build (both programs)
make test         # anchor test (all test suites)
make lint         # cargo clippy + eslint (frontend + services)
make idl          # anchor build + copy IDL JSON to frontend/services

# Devnet (default target)
make setup        # install deps, airdrop SOL, create mock USDC mint (run once)
make deploy       # deploy both programs to devnet (idempotent)
make init         # initialize config + oracle feeds + test markets + ALTs
make airdrop      # fund test wallets with SOL + mock USDC
make frontend     # start Next.js dev server (devnet)
make services     # start oracle-feeder + amm-bot + market-initializer + event-indexer (devnet)
make dev          # copies .env.devnet → .env, build + deploy + init + frontend + services (full stack)

# Mainnet (Phase 6)
make deploy:mainnet   # deploy both programs to mainnet-beta (idempotent, uses mainnet keypair)
make init:mainnet     # initialize config with real USDC + Pyth oracle
make dev:mainnet      # copies .env.mainnet → .env, build + frontend + services (full stack, mainnet)

# Cleanup
make clean        # remove build artifacts + target dirs
```

`make dev` is the one-command README setup: from zero to running prototype.

---

## Engineering Discipline

### Module boundaries (no god-files)

**Rust/Anchor programs:**
- One instruction per file: `instructions/initialize_config.rs`, `instructions/place_order.rs`, etc. — never a single `processor.rs` with all match arms
- State accounts each in their own file: `state/config.rs`, `state/strike_market.rs`, `state/order_book.rs`
- Matching engine logic in `matching/engine.rs` — pure functions that take order book data and return fills. No account deserialization inside the engine.
- Error enum in `error.rs` — Anchor error codes, never string messages
- No `unwrap()` in any production code — proper error propagation with `?` and custom errors
- Max ~300 lines per file. If a file grows beyond that, extract a helper module.

**Frontend (TypeScript/React):**
- **lib/** = pure functions (math, PDA derivation, Tradier client). Zero React imports. Independently testable.
- **hooks/** = data fetching + state management. Each hook does one thing (`useMarkets`, `useOrderBook`, `usePortfolio`). Uses TanStack Query for caching/polling.
- **components/** = display only. Receive data via props or hooks. No direct RPC calls in components.
- Strict TypeScript (`strict: true`). Exhaustive switch cases. No `any`.
- Shared types in `types/` — one canonical definition per domain object, never duplicate.

**Services (TypeScript/Node):**
- 3-layer pattern per service:
  - **Client layer**: API calls (Tradier HTTP, Anchor RPC). Pure I/O, no logic.
  - **Logic layer**: calculations, strike selection, pricing. Pure functions, fully testable without network.
  - **Executor layer**: orchestration (read price → calculate → submit tx). Thin glue between client and logic.
- Each service is independently runnable (`npx ts-node services/oracle-feeder/src/index.ts`)

### Code quality rules

- No dead code, no commented-out code (use git history)
- No barrel exports (`index.ts` re-exporting everything) — import directly from the source file
- Tests live in `tests/` directory (Anchor convention), not next to source files
- Every public function has a JSDoc/Rustdoc comment explaining *what* (not *how*)
- Constants extracted to top of file or shared `constants.ts` / `constants.rs` — no magic numbers
- Errors are specific: 40+ variants across 11 categories (see Error Codes section). Every failure mode has a unique code. No generic errors.

### Complexity guardrails

- If a function exceeds 40 lines, extract helpers
- If a component exceeds 150 lines, split into sub-components
- If a test file exceeds 300 lines, split by scenario group
- No nested callbacks deeper than 2 levels — use async/await or extract
- Frontend state: TanStack Query for server state, React state for UI state — never mix or duplicate

---

## Smart Contract Instructions (16 total: 13 core + 3 mainnet)

**Phases 1–3** deliver **13 instructions** — all spec requirements plus extras (`set_market_alt`, `crank_cancel`, `admin_override_settlement`, `pause`, `unpause`). These are the core instructions; every file in `programs/meridian/src/instructions/` during Phases 1–3 corresponds to exactly one of these 13.

**Phase 6** adds **3 mainnet-only instructions** (`close_market`, `treasury_redeem`, `cleanup_market`) for rent sustainability. These are beyond spec scope and not required for the devnet prototype.

| # | Instruction | Phase | Notes |
|---|---|---|---|
| 1 | `initialize_config` | 1 | Admin, USDC mint, oracle program, staleness/confidence thresholds, tickers. Also creates TreasuryPDA (`[b"treasury"]`) USDC token account. |
| 2 | `create_strike_market` | 1 | Admin-only. Creates market PDA + Yes/No mints + vaults (including No Escrow) + order book. `alt_address` initialized to `Pubkey::default()`. Accepts `market_close_unix`. Also serves as `add_strike` (callable anytime by admin). |
| 2b | `set_market_alt` | 1 | Admin-only. One-time write of ALT address to `StrikeMarket.alt_address`. Requires `alt_address == Pubkey::default()` (prevents overwrite). Called by market creation script after ALT creation + extension. Trivial instruction (~20 lines). |
| 3 | `mint_pair` | 1 | Any user deposits 1 USDC → 1 Yes + 1 No. Creates ATAs via `init_if_needed`. Market must not be settled/paused. Position constraint: rejects if user's Yes ATA balance > 0 (checked via Anchor account constraint **before** any CPI — see Position Constraint Timing below). **Intentionally does NOT check No balance** — the atomic Buy No flow (mint + sell Yes in one tx) requires minting while holding No. |
| 4 | `place_order` | 2 | Three side types: `side=0` (USDC bid, Buy Yes), `side=1` (Yes ask, Sell Yes), `side=2` (No-backed bid, Sell No). Escrows USDC, Yes, or No tokens respectively. Market or Limit. `max_fills` param caps compute. Min size: 1 token. When No-backed bid matches Yes ask → merge/burn (see Merge/Burn Vault Math below). Position constraint on side=0: rejects if user's No ATA balance > 0 (checked **before** matching — see Position Constraint Timing below). |
| 5 | `cancel_order` | 2 | Owner only. Refund from escrow (USDC, Yes, or No based on order's `side`). Works post-settlement too. Cancel by `(price_level, order_id)`. |
| 6 | `settle_market` | 3 | Anyone calls. Requires `Clock >= market_close_unix`. Oracle staleness (120s) + confidence (0.5% bps) validated. Sets outcome + `override_deadline = settled_at + 3600`. Phase 6 adds Pyth oracle path via `oracle_type` flag in GlobalConfig. |
| 7 | `admin_settle` | 3 | Admin only. Requires `Clock >= market_close_unix + 3600`. Accepts manual price. Fails if already settled. |
| 8 | `admin_override_settlement` | 3 | Admin only. Requires `is_settled == true`, `Clock < override_deadline`, `override_count < 3`. Corrects outcome + settlement_price. Resets `override_deadline = now + 3600`. Increments `override_count`. After deadline or 3 overrides, outcome is truly final. |
| 9 | `redeem` | 3 | Two modes: **(1) Pair burn** (Yes + No → $1): anytime, no settlement required, not blocked by override window (outcome-independent). **(2) Winner/loser** (winning → $1, losing → $0): requires settlement, **blocked during override window** (1hr post-settlement). |
| 10 | `crank_cancel` | 3 | Permissionless. Market must be settled. Iterates up to 32 order slots per call, returns escrow (USDC, Yes, or No) to owners. **Not blocked by override window** (escrow refunds are outcome-independent — see Override Window Safety below). |
| 11 | `pause` | 2 | Admin only. Global (`GlobalConfig.is_paused`) or per-market (`StrikeMarket.is_paused`). |
| 12 | `unpause` | 2 | Admin only. Resume. |
| 13 | `close_market` | 6 | Admin only. Standard close (all redeemed): closes all 8 accounts. Partial close (90 days, tokens remain): closes 5 big accounts (OrderBook + USDC Vault + Escrow Vault + Yes Escrow + No Escrow), keeps StrikeMarket + mints as settlement record, revokes mint authority, sweeps vault to treasury. |
| 14 | `treasury_redeem` | 6 | Permissionless, no time limit. Burns tokens from partially-closed markets, pays winners $1 USDC from Treasury PDA. Late-claim path — users always have recourse. |
| 15 | `cleanup_market` | 6 | Admin only. Closes remaining 3 accounts (StrikeMarket + mints) once Yes and No mint supply both = 0. Final cleanup for zero on-chain footprint. |

Note: `add_strike` folded into `create_strike_market` (same logic, admin access). `auto_redeem` folded into `redeem` (user can burn Yes+No pair for $1 anytime). Sell No is handled via `place_order(side=2)` — No-backed bid paradigm. No tokens are escrowed in `no_escrow`; when matched against a Yes ask, both tokens are merge/burned and $1 released from vault. No separate `sell_no` instruction needed. `crank_cancel` is permissionless post-settlement cleanup — iterates order slots in batches, returns escrow funds (USDC, Yes, or No) to owners. Settlement service calls in a loop; manual `cancel_order` still works alongside for users who act first. `admin_override_settlement` provides a 1hr safety valve — admin can correct a bad oracle settlement within the override window. Redemptions blocked during this window to prevent payouts on a potentially incorrect outcome. Override resets the deadline, giving another hour, and increments `override_count`. Maximum 3 overrides (3 hours total window) — after that, `MaxOverridesExceeded` prevents further changes. After the deadline passes or max overrides are used, outcome is truly immutable. `close_market` is the mainnet sustainability instruction — without it, rent accumulates without bound from expired markets. `treasury_redeem` ensures users always have a claim path, even after market accounts are partially closed. `cleanup_market` is the final step — closes the remaining settlement record once all tokens are burned.

---

## Critical Path

```
workspace setup -> meridian state -> mint_pair -> matching engine -> place_order (all 3 sides + merge/burn) ->
settle_market -> crank_cancel -> redeem -> IDL generation -> frontend hooks -> components -> pages
```

## Key Files to Create

**Programs (Rust/Anchor):**
- `programs/meridian/src/state/config.rs` — GlobalConfig (see Account Schemas)
- `programs/meridian/src/state/strike_market.rs` — StrikeMarket (see Account Schemas)
- `programs/meridian/src/state/order_book.rs` — ZeroCopy OrderBook + PriceLevel + OrderSlot (see Account Schemas)
- `programs/meridian/src/state/events.rs` — FillEvent, SettlementEvent (Anchor `emit!`)
- `programs/meridian/src/matching/engine.rs` — Price-time priority matching (market + limit, max_fills)
- `programs/meridian/src/instructions/` — 13 core instruction handlers in Phases 1–3 (one file each): `initialize_config.rs`, `create_strike_market.rs`, `set_market_alt.rs`, `mint_pair.rs`, `place_order.rs` (three-side matching + merge/burn), `cancel_order.rs`, `settle_market.rs`, `admin_settle.rs`, `admin_override_settlement.rs`, `redeem.rs`, `crank_cancel.rs`, `pause.rs`, `unpause.rs`. Phase 6 adds 3 more: `close_market.rs`, `treasury_redeem.rs`, `cleanup_market.rs`.
- `programs/meridian/src/error.rs` — Full `#[error_code]` enum (see Error Codes section — 40+ variants across 11 categories)
- `programs/mock-oracle/src/state/price_feed.rs` — PriceFeed (see Account Schemas)
- `programs/mock-oracle/src/instructions/` — initialize_feed, update_price

**Frontend (TypeScript/React):**
- `app/meridian-web/src/lib/pda.ts` — PDA derivation (mirrors PDA Registry seeds exactly)
- `app/meridian-web/src/lib/greeks.ts` — Binary delta/gamma formulas
- `app/meridian-web/src/lib/volatility.ts` — HV calculation from OHLCV
- `app/meridian-web/src/lib/tradier.ts` — Tradier API client (via `/api/tradier/*` routes only, never direct)
- `app/meridian-web/src/lib/strikes.ts` — Strike selection (±3/6/9%, $10 rounding, dedup)
- `app/meridian-web/src/lib/errors.ts` — Anchor error code → user-friendly message mapping
- `app/meridian-web/src/hooks/useTransaction.ts` — Sign → send → confirm lifecycle with loading states
- `app/meridian-web/src/hooks/use*.ts` — Anchor + Tradier hooks (useMarkets, useOrderBook, usePortfolio)
- `app/meridian-web/src/components/markets/OrderBook.tsx` — Bid/ask depth (both perspectives), WebSocket subscriptions. Accepts `perspective: "yes" | "no"` prop. Yes view: USDC bids + No-backed bids on left, Yes asks on right. No view: real No depth from No-backed bids, inverted Yes asks. Uses `buildNoView()` from `lib/orderbook.ts`.
- `app/meridian-web/src/lib/orderbook.ts` — Order book data transforms: `buildNoView(book)` separates orders by side and applies price inversions for No perspective. Depth aggregation, spread calculation.
- `app/meridian-web/src/app/market-maker/page.tsx` — Market Maker dashboard page
- `app/meridian-web/src/hooks/useMarketMaker.ts` — Aggregation hook: inventory, open orders, fill history across all markets
- `app/meridian-web/src/hooks/useMMAccess.ts` — Checks connected wallet against `NEXT_PUBLIC_MM_WALLETS` allowlist (mainnet gate). Returns `{ hasAccess: boolean }`. On devnet, always returns true.
- `app/meridian-web/src/lib/tradier-proxy.ts` — Shared Tradier API proxy: 60s TTL caching, rate limiting, error fallback (Phase 4A gate)
- `app/meridian-web/src/hooks/useAnalyticsData.ts` — Shared data-fetching hook for analytics components (Phase 4A gate)
- `app/meridian-web/src/lib/chartConfig.ts` — Shared chart styling/theme constants (Phase 4A gate)
- `app/meridian-web/src/components/SettlementStatus.tsx` — Settlement countdown + override window indicator (Phase 3B, single component)
- `app/meridian-web/src/components/analytics/*.tsx` — All differentiator components
- `app/meridian-web/src/app/api/tradier/` — Next.js API routes (CORS proxy for Tradier)
- `app/meridian-web/src/app/api/faucet/sol/route.ts` — Devnet SOL airdrop endpoint (calls `connection.requestAirdrop`)
- `app/meridian-web/src/app/api/faucet/usdc/route.ts` — Devnet mock USDC mint endpoint (server-side `mintTo` using faucet keypair)
- `app/meridian-web/src/hooks/useWalletState.ts` — Wallet state machine: no-wallet → zero-sol → zero-usdc → funded → has-positions
- `app/meridian-web/src/hooks/useNetwork.ts` — Returns `"devnet" | "mainnet-beta"` from `NEXT_PUBLIC_SOLANA_NETWORK`. Drives faucet visibility, trade confirmations, risk disclaimers, explorer link cluster param.
- `app/meridian-web/next.config.js` — webpack fallback for crypto/buffer/stream polyfills

**Services (TypeScript/Node):**
- `services/oracle-feeder/src/feeder.ts` — Tradier streaming → on-chain oracle update
- `services/amm-bot/src/pricer.ts` — Black-Scholes binary option pricing
- `services/market-initializer/src/strikeSelector.ts` — Strike generation (baseline + vol-aware)
- `services/market-initializer/src/scheduler.ts` — Timed jobs with DST-aware ET conversion
- `services/shared/src/tradier-client.ts` — Shared HTTP client with token-bucket rate limiter
- `services/shared/src/alerting.ts` — Logging + admin alerting for failures
- `services/event-indexer/src/db.ts` — SQLite schema setup (`better-sqlite3`), table definitions (`fills`, `settlements`, `cancels`, `redeems`, `checkpoints`), query helpers
- `services/event-indexer/src/watcher.ts` — `connection.onLogs` listener, parses Anchor events, writes to SQLite
- `services/event-indexer/src/backfill.ts` — Incremental backfill from checkpoint via `getSignaturesForAddress` + log parsing
- `services/event-indexer/src/api.ts` — Express/Fastify REST API for querying events (SQL-backed filtering, pagination). **Access control**: on Railway, configured as a private service (internal hostname `event-indexer.railway.internal:PORT`) — only reachable by other services in the same Railway environment (meridian-web proxies via `/api/events/*` routes). Not publicly accessible. Locally, rate-limited at 100 requests/IP/minute (in-memory token bucket). No API key needed — the data is all public on-chain; the concern is DoS, not confidentiality.

**Scripts:**
- `scripts/create-mock-usdc.ts` — Create SPL token mint (6 decimals) on devnet
- `scripts/airdrop-usdc.ts` — Mint mock USDC to test wallets
- `scripts/init-config.ts` — Initialize GlobalConfig
- `scripts/init-oracle-feeds.ts` — Initialize PriceFeed for all 7 tickers
- `scripts/create-test-markets.ts` — Create strikes for demo
- `scripts/deploy-devnet.sh` — Idempotent full deployment (runs in order: deploy → mock USDC → init config → init feeds)

**Deployment & Environment:**
- `.env.devnet.example` — Devnet env var template (mock USDC, mock oracle, faucet keypair)
- `.env.mainnet.example` — Mainnet env var template (real USDC, Pyth, Helius RPC, no faucet)
- `app/meridian-web/railway.toml` — Railway config for Next.js frontend
- `services/oracle-feeder/railway.toml` — Railway config for oracle feeder
- `services/market-initializer/railway.toml` — Railway config for market initializer + settlement
- `services/amm-bot/railway.toml` — Railway config for AMM bot
- `services/event-indexer/railway.toml` — Railway config for event indexer

**Tests:**
- `tests/meridian/*.test.ts` — Lifecycle, trade paths, matching, settlement, escrow, crank_cancel
- `tests/mock-oracle/oracle.test.ts` — Price feed CRUD + validation + staleness
- `tests/helpers/` — Mock wallet context, mock Anchor program, test data factories, mock WebSocket subscription (`onAccountChange`) for testing real-time oracle price updates (verify component re-renders on price change)
- Uses `solana-bankrun` for clock manipulation (settle timing, admin_settle delay, oracle staleness). See "Bankrun + ZeroCopy Decision Point" section for fallback rules — decision is locked in Stage 1D, no mixed runtimes after that.

---

## Spec Coverage Checklist

Every spec requirement mapped to a phase:

**Smart Contract (Phase 1-3 + Phase 6, 15 instructions):**
- [P1] initialize_config, create_strike_market (also serves as add_strike), mint_pair
- [P2] place_order (market + limit, `max_fills` param, three side types: USDC bid / Yes ask / No-backed bid, merge/burn on No×Yes match), cancel_order (works anytime including post-settlement)
- [P3] settle_market (anyone, >= rule), admin_settle (admin, 1hr delay), admin_override_settlement (1hr correction window), redeem (two modes: pair burn anytime, winner/loser blocked during override window), crank_cancel (permissionless batch cleanup), pause, unpause
- [P6] close_market (admin, standard close if all redeemed; partial close after 90 days — closes OrderBook + vaults, keeps settlement record, sweeps unclaimed USDC to treasury)
- [P6] treasury_redeem (permissionless, no time limit — late claim against treasury for partially-closed markets)
- [P6] cleanup_market (admin, closes remaining StrikeMarket + mints once all token supply is burned)

**Invariants (enforced on-chain):**
- [P1] Vault balance = $1.00 x total pairs minted (zero fees — vault holds only collateral)
- [P3] Yes payout + No payout = $1.00 always
- [P1] Tokens only created via mint_pair, only destroyed via redeem
- [P3] Settlement outcome immutable after override window (1hr post-settlement)

**Oracle (Phase 1, 3):**
- [P1] PriceFeed with price, timestamp, confidence
- [P3] Two-tier staleness check: 60s for general ops, 120s for settlement (both configurable in GlobalConfig)
- [P3] Confidence check: 0.5% of price (configurable in GlobalConfig as basis points)
- [P3] Settlement reads oracle on-chain
- [P1] Pre-market price read via Tradier API (off-chain)
- [P3] Failure: retry 30s x 15min, then alert admin for override

**Trade Paths (Phase 2):**
- [P2] Buy Yes: market or limit buy from asks
- [P2] Buy No (market): atomic mint + sell Yes at best bid
- [P2] Buy No (limit): atomic mint + post Yes limit sell, hold both until fill. Warning UX + "Cancel & Recover" button in portfolio. **Cancel & Recover flow**: composes `cancel_order` (returns Yes from escrow) + `redeem` pair-burn mode (Yes + No → $1 USDC) in a single atomic transaction. User recovers original USDC minus any partial fills. Without the pair-burn step, the user is stuck holding Yes+No tokens that block future `mint_pair` calls (position constraint). Frontend builds both instructions into one `VersionedTransaction`.
- [P2] Sell Yes: sell order on ask side
- [P2] Sell No: `place_order(side=2)` — No-backed bid. No tokens escrowed; when matched against Yes ask, merge/burn releases $1 from vault. Market and limit variants.

**Strike Selection (Phase 1, enhanced Phase 4):**
- [P1] Baseline: ±3%, ±6%, ±9% from prev close, round to $10, deduplicate
- [P1] Optionally include rounded prev close as 7th strike
- [P3] Admin can add strikes intraday via add_strike
- [P4] Vol-aware enhancement: HV-based 1/1.5/2 sigma levels

**Frontend Pages (Phase 2-3):**
- [P5] Landing: product explanation, live prices, connect wallet CTA
- [P2] Markets: grid of 7 stocks with live prices and active contract counts
- [P2] Trade: strike list, order book (Yes + No perspectives), Buy/Sell panel
- [P3] Portfolio: active positions, settled outcomes, P&L, redeem buttons
- [P3] History: trade execution log (sourced from event indexer)
- [P3] Market Maker: dedicated dashboard — inventory, open orders, quick mint+quote, fill history, net exposure

**Frontend UI Elements (Phase 2-3):**
- [P2] Wallet USDC balance display (always visible)
- [P2] Contract cards: strike, Yes/No prices, implied probability
- [P2] Real-time order book from CLOB, both perspectives
- [P2] Trade panel: Buy Yes / Buy No / Sell Yes / Sell No, with position constraints
- [P2] Market/Limit order toggle
- [P3] Settlement countdown timer to 4:00 PM ET
- [P3] Payoff display: "You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]."
- [P3] Portfolio: entry price, current price, P&L, redeem button
- [P3] Real-time oracle price display per stock
- [P3] Market Maker view: mint pairs, post quotes, see exposure/fills/P&L

**Position Constraints (Phase 2):**
- [P2] Can't Buy Yes if holding No (prompt to sell No first)
- [P2] Can't Buy No if holding Yes (prompt to sell Yes first)
- [P2] Frontend checks token balances before presenting trade options
- [P2] Yes+No holding is only transient during mint-pair

**Automation Service (Phase 3):**
- [P3] 8:00 AM ET: read prev close from Tradier, calculate strikes
- [P3] 8:30 AM ET: create contracts + order books, log results, alert on failure, retry with backoff
- [P3] 9:00 AM ET: markets visible on frontend
- [P3] ~4:05 PM ET: settlement job — read close, update oracle, settle all
- [P3] Retry on wide confidence: every 30s for 15 min, then alert admin
- [P3] Service in same repo (monorepo)

**Testing (Phase 1-3):**
- [P1] Unit tests: mint, config, market creation
- [P2] Unit tests: place_order, cancel_order, matching engine (20+ scenarios)
- [P3] Settlement: at-strike (>=), above, below
- [P3] Invariant tests: payout sum, vault balance
- [P3] Oracle validation: stale, wide confidence, valid
- [P3] Admin override: time delay enforced
- [P3] Integration: full lifecycle create -> mint -> trade -> settle -> crank_cancel -> redeem
- [P2] All 4 trade paths e2e
- [P3] Multi-user: maker mints/quotes, taker fills, both redeem
- [P2] Frontend: wallet connection, order placement + tx signing
- [P2] Frontend: order book rendering (both views)
- [P2] Frontend: position constraint enforcement
- [P3] Frontend: real-time price display from oracle (test via mock `onAccountChange` subscription — emit price update, verify component re-renders with new value)
- [P3] Frontend: portfolio + P&L accuracy
- [P3] Frontend: settlement display + redeem flow

**Deployment (Phase 5):**
- [P5] Devnet deployment with reproducible scripts
- [P5] Full lifecycle demo: create -> mint -> trade -> settle -> crank_cancel -> redeem
- [P5] Tests run locally, validate all invariants
- [P5] Clear README with one-command setup
- [P5] .env.example
- [P5] Architecture doc with chain rationale + trade-offs
- [P5] HyperLiquid feasibility note (why not chosen)
- [P5] Risks/limitations note
- [P5] Dependency justification

**Mainnet Deployment — Bonus (Phase 6):**
- [P6] Deploy to Solana mainnet-beta with dedicated mainnet keypair
- [P6] Real USDC mint (`EPjFWdd5...`) — zero code changes, config only
- [P6] Pyth oracle integration (replace mock oracle for settlement)
- [P6] `close_market` + `treasury_redeem` + `cleanup_market` — three-phase market closure lifecycle with indefinite late-claim path
- [P6] Funded automation wallet (~100 SOL for deployment + rent + daily tx fees)
- [P6] Helius RPC (free tier, 50 RPS)
- [P6] Monitoring + Discord alerting (wallet balance, oracle freshness, settlement completion)
- [P6] Program upgrade authority transfer to multisig (Squads) or revoke with `--final`

**Success Criteria:**
- Core logic correct (mint, trade, settle, redeem)
- $1.00 invariant never violated
- All 4 trade paths functional
- Settlement + escrow cleanup within 10 minutes of market close
- Frontend: real-time prices, order books (both views), positions, settlement
- Position constraints enforced
- Clear trade-offs documented
- Unredeemed tokens redeemable for 90 days post-settlement (unclaimed funds swept to treasury after grace period)

---

## Infrastructure & Practical Considerations

### Mock USDC on Devnet
Real USDC doesn't exist on Solana devnet. We create our own SPL token:
- `scripts/create-mock-usdc.ts` — generates a dedicated faucet keypair, creates an SPL mint with 6 decimals using the faucet keypair as mint authority (not the deployer). **Automatically writes `FAUCET_KEYPAIR`, `USDC_MINT`, and `NEXT_PUBLIC_USDC_MINT` to `.env`** (appends if not present, updates if present). No manual copy-paste step — `make dev` runs this script and `.env` is ready for the frontend.
- `scripts/airdrop-usdc.ts` — mints mock USDC to test wallets (deployer, test users)
- GlobalConfig stores the mock USDC mint address; all program instructions reference it
- Frontend `.env` includes `NEXT_PUBLIC_USDC_MINT` pointing to our devnet mock mint
- On mainnet, swap to real USDC mint address — zero code changes needed

### Wallet Funding
Two paths — CLI for developers, in-app for end users:

**CLI (developer/testing):**
- Devnet SOL: `solana airdrop 5 <wallet>` (built into Solana CLI, free on devnet)
- Mock USDC: `scripts/airdrop-usdc.ts <wallet> <amount>` — mints tokens to any wallet

**In-app faucet (end users — devnet only):**
- SOL: `/api/faucet/sol` — calls `connection.requestAirdrop(wallet, 2 SOL)`. Button in header when SOL balance < 0.01.
- USDC: `/api/faucet/usdc` — server-side `mintTo(wallet, 1000 USDC)` using faucet keypair (USDC mint authority). Button in header when USDC balance is 0.
- Rate limit: 1 request per wallet per 60 seconds (in-memory map). Prevents abuse without needing a database.
- **Faucet keypair**: A **dedicated keypair** used only as the mock USDC mint authority. Generated separately from the deployer keypair — `create-mock-usdc.ts` generates a new keypair, creates the mint with it as authority, and writes the base58-encoded secret key directly to `.env` as `FAUCET_KEYPAIR` (along with `USDC_MINT` and `NEXT_PUBLIC_USDC_MINT`). This keypair can mint mock USDC but cannot deploy programs, act as admin, or sign any other instruction. Principle of least privilege — consistent with the mainnet keypair separation strategy.
- On mainnet: faucet routes return 403. No `FAUCET_KEYPAIR` exists. Users acquire real USDC from exchanges.

### Deployment

**4 environments**, 2 local (development) + 2 deployed (Railway):

| Environment | Runtime | Solana Cluster | USDC | Oracle | Faucet | RPC | Purpose |
|-------------|---------|----------------|------|--------|--------|-----|---------|
| `devnet-local` | `make dev` | devnet | Mock mint | Mock | Active | Public devnet | Day-to-day development |
| `devnet-prod` | Railway (`devnet` env) | devnet | Mock mint | Mock | Active | Public devnet | Live demo, evaluator access, public URL |
| `mainnet-local` | `make dev:mainnet` | mainnet-beta | Real USDC | Pyth | Disabled | Helius | Test mainnet integration locally |
| `mainnet-prod` | Railway (`mainnet` env) | mainnet-beta | Real USDC | Pyth | Disabled | Helius | Real money, real users |

**Environment selection**: Driven entirely by env vars — no code branches, no build flags. The same Next.js build serves devnet or mainnet based on `NEXT_PUBLIC_SOLANA_NETWORK` and `NEXT_PUBLIC_SOLANA_RPC_URL`. Faucet routes check `NEXT_PUBLIC_SOLANA_NETWORK !== "mainnet-beta"` before serving.

**Env file convention**:
- `.env.devnet` — local devnet development (copied to `.env` by `make dev`)
- `.env.mainnet` — local mainnet development (copied to `.env` by `make dev:mainnet`)
- `.env.devnet.example` / `.env.mainnet.example` — committed templates with placeholders
- Railway environments get their own var sets in the dashboard (no `.env` files deployed)

**Railway architecture** — single Railway project, two environments, 5 services each:

```
Railway project: meridian
├── Environment: devnet
│   ├── meridian-web        (Next.js frontend + faucet + Tradier proxy)
│   ├── oracle-feeder       (Tradier streaming → mock oracle)
│   ├── market-initializer  (morning strikes + afternoon settlement)
│   ├── amm-bot             (liquidity seeder)
│   └── event-indexer       (log watcher + trade history API, 1GB volume at /data, private service)
└── Environment: mainnet
    ├── meridian-web        (Next.js frontend, faucet disabled)
    ├── oracle-feeder       (Tradier streaming → Pyth price verification)
    ├── market-initializer  (morning strikes + afternoon settlement)
    ├── amm-bot             (liquidity seeder)
    └── event-indexer       (log watcher + trade history API, private service)
```

- **Deploy triggers**: `devnet` env auto-deploys from `main` branch. `mainnet` env deploys from `release` branch (manual merge from `main` → `release` for controlled rollout).
- **Domain**: `devnet` gets `meridian-devnet.up.railway.app`. `mainnet` gets `meridian.up.railway.app` (or custom domain).
- **Cost**: Railway Hobby plan ($5/mo credit) does **not** cover 5 always-on services — expect ~$25-30/mo for devnet (5 services × ~256MB RAM continuous). Mainnet adds a similar amount. Persistent volumes add ~$0.25/mo per environment (1GB each for event-indexer). To reduce cost: scale down AMM bot and event-indexer to minimum resources, or run them on-demand rather than always-on.
- **Local dev**: `make dev` and `make dev:mainnet` run the full stack locally. Railway is the deployed target.

### Transaction Reliability

Solana transactions can be dropped by validators (never landed), or expire (blockhash too old). Both are common on devnet and occasional on mainnet. Every transaction submitter must handle this.

**Services (settlement, AMM bot, market initializer):**
- Use `sendAndConfirmTransaction` with `maxRetries: 3`, `skipPreflight: false`
- On confirmation timeout (30s), check `isBlockhashValid()` — if expired, rebuild the transaction with a fresh `recentBlockhash` and resubmit. Cap at 3 full rebuilds before alerting.
- Settlement service: if a `settle_market` tx fails 3 times, fall through to the existing 30s retry loop (which already handles oracle staleness). If `crank_cancel` tx fails, retry immediately — cranks are idempotent.

**Priority fees:**
- Devnet: set `ComputeBudgetProgram.setComputeUnitPrice(1)` on all transactions. Trivial cost, helps with validator scheduling.
- Mainnet: use dynamic fee strategy — query `getRecentPrioritizationFees()` for the program's accounts, set price to the 50th percentile. Add a `PRIORITY_FEE_LAMPORTS` env var as override for spikes.

**Frontend `useTransaction` hook:**
- Already has sign → send → confirm flow. Add blockhash expiry detection: if confirmation times out, check `isBlockhashValid()`. If expired, rebuild the transaction, re-sign, and resubmit. Show "Transaction expired, retrying..." toast.
- Cap at 2 automatic retries, then show "Transaction failed — please try again" with a manual retry button.
- Never silently retry `place_order` — a retry could double-place if the first tx actually landed but confirmation was slow. Check the order book for the user's order before retrying.

### Transaction Size & Compute Budget
- Solana tx limit: 1,232 bytes. All transactions use v0 + ALTs, so account key overhead is ~1 byte each instead of 32. Size is never a constraint, even for heaviest instructions (Buy No, Sell No merge/burn via `place_order`).
- Default compute: 200,000 CUs. Simple operations (mint, cancel) are well under. Standard swap fills: request 400k CUs (`max_fills=10`). **Merge/burn fills (No-backed bid × Yes ask): request 800k CUs** (`max_fills=5`) — each merge/burn involves 4 CPIs (2 burns + 2 transfers), estimated ~80k–120k CUs per fill. 800k provides headroom at 5 fills. Solana max is 1,400,000 CUs. Exact values locked by CU measurement gate in Phase 2C.

### Order Book Account Sizing
- ZeroCopy account with 99 price levels (1-99 cents). Each level has N order slots.
- Start with `MAX_ORDERS_PER_LEVEL = 16`. That gives 99 * 16 = 1,584 order slots.
- Each order slot: 73 bytes as listed, but **80 bytes with `repr(C)` alignment** (7 bytes implicit padding between `side: u8` and `timestamp: i64`). PriceLevel = 16 × 80 + 8 (count u8 + 7 trailing alignment) = 1,288 bytes. OrderBook = 32 + 8 + 99 × 1,288 + 8 (bump + trailing) = ~127,560 bytes ≈ **~125 KB**. Lock exact size with `std::mem::size_of` in Phase 1A.
- Solana max account: 10 MB. We're well under. Rent cost: ~1 SOL on devnet (free via airdrop).
- If 16 slots/level proves too small: split into BidBook/AskBook accounts later.

### Devnet Rollback Strategy

If a deployment or initialization fails partway through, use the following recovery approach:

**Programs (anchor deploy failure):**
- Solana programs are upgradeable by default. A failed `anchor deploy` leaves the old program intact — just fix and redeploy.
- If deploying for the first time and the BPF upload fails mid-stream: the program ID is unused. Retry `anchor deploy` — it will overwrite the incomplete buffer.
- If a deployed program is fundamentally broken (bad state transitions, wrong PDA seeds): deploy a new version with `anchor deploy`. All existing PDAs remain addressable because seeds are deterministic. If PDA seeds changed, you must redeploy to a **new program ID** (delete `target/deploy/*.json` keypairs, `anchor deploy` generates fresh ones). This orphans all old accounts — acceptable on devnet.

**Initialization scripts (partial init):**
- All init scripts are idempotent (see Initialization Order section). Re-running after partial failure picks up where it left off.
- If `init-config.ts` succeeds but `init-oracle-feeds.ts` fails: just re-run the full init sequence. `init-config.ts` catches `ConfigAlreadyInitialized` and skips.
- If state is irrecoverably wrong (e.g., GlobalConfig initialized with wrong USDC mint): redeploy both programs to new program IDs. On devnet, this is free and fast — no data to preserve.

**Nuclear option (devnet only):**
- Delete `target/deploy/meridian-keypair.json` and `target/deploy/mock_oracle-keypair.json`.
- Run `anchor deploy` — generates new program IDs, deploys fresh.
- Re-run all init scripts from scratch.
- Cost: ~2 SOL airdrop (free on devnet). Time: ~2 minutes.
- **Never do this on mainnet** — it orphans all existing user accounts and tokens.

**Mainnet recovery (Phase 6):**
- Programs are upgradeable. Fix the bug, `anchor deploy` with the same program ID.
- If upgrade authority was revoked (`--final`): you're stuck. This is why the plan keeps programs upgradeable until stable.
- Account state errors: deploy a migration instruction that corrects bad state. Never redeploy to a new program ID on mainnet.

### Bankrun + ZeroCopy Decision Point

`solana-bankrun` is the preferred test runtime (fast, clock manipulation, no validator process). However, bankrun's deserialization of large ZeroCopy accounts (~125 KB OrderBook) is unproven.

**Decision rule**: Test bankrun + ZeroCopy compatibility in **Stage 1D** (first test that touches OrderBook). If the OrderBook initialization test can create, write to, and read back a ZeroCopy OrderBook account in bankrun without deserialization errors:
- **Pass**: Use bankrun for all test suites. No further action.
- **Fail**: Switch **immediately** to `solana-test-validator` with `warp_to_slot` for clock manipulation. Do not spend time debugging bankrun internals — the ROI is negative. Update all test helpers to use `solana-test-validator` before proceeding to Phase 2.

This decision must be made and documented in DEV_LOG before any Phase 2 test work begins. Every test file after this point uses whichever runtime was chosen — no mixed runtimes.

### Position Constraint Timing

Position constraints in `mint_pair` and `place_order` must fire **before** any state mutation (token minting, escrow transfers, order book writes). Implementation:

- **`mint_pair`**: The user's Yes ATA is passed as a read-only account in the Anchor `#[derive(Accounts)]` struct. An Anchor `constraint` attribute checks `user_yes_ata.amount == 0` (or the account doesn't exist). This validation runs during Anchor's account deserialization phase — before the instruction handler body executes. If the user holds any Yes tokens, the tx fails with `ConflictingPosition` before any USDC is transferred or tokens minted. **No balance is intentionally NOT checked** — the atomic Buy No flow (`mint_pair` + `place_order(side=1)` in one tx) requires minting while holding No. Checking No balance would break this path for users adding to existing No positions.
- **`place_order` (side=0, Buy Yes)**: Same pattern — user's No ATA passed as read-only, `constraint` checks `amount == 0`. Fires before matching engine runs.
- **ATA doesn't exist yet**: If the user has never received Yes/No tokens for this market, the ATA won't exist. Use `Option<Account<TokenAccount>>` — if `None`, constraint passes (no tokens = no conflict). If `Some`, check `amount == 0`.

**Why this matters**: If the constraint checked *after* minting (in `mint_pair`), the tx would always fail — `mint_pair` itself creates Yes tokens. The check must see the user's balance as of the start of the transaction, not mid-execution.

### Merge/Burn Vault Math

When a No-backed bid (side=2) matches a Yes ask (side=1), both tokens are merge/burned and $1 USDC is released from the vault. The payout split follows the **resting order's price** (price-time priority — the resting order's terms are honored):

**Example**: Resting Yes ask at price 60 ($0.60). Incoming No-backed bid at price 45 ($0.45 for No = willing to pay up to $0.55 for the merge). Fill price = 60 (resting order's price).

- **Yes seller (maker, resting ask)**: Receives $0.60 USDC per token from vault. They had escrowed Yes tokens; those are burned.
- **No seller (taker, incoming No-backed bid)**: Receives $0.40 USDC per token from vault (= $1.00 − $0.60). They had escrowed No tokens; those are burned.
- **Vault**: Decrements by `quantity` (in token lamports) — exactly $1.00 per merged pair.
- **`total_redeemed`**: Increments by `quantity` — these pairs are economically settled.
- **Token supplies**: Yes supply decreases by `quantity`, No supply decreases by `quantity`. Both supplies remain equal.

**Payout formula** (per unit, in USDC lamports):
```
USDC_LAMPORTS_PER_DOLLAR = 1_000_000   // 6 decimal places
PRICE_TO_USDC_LAMPORTS = 10_000        // = USDC_LAMPORTS_PER_DOLLAR / 100 (price range is 1-99 cents)

fill_price_usdc = fill_price * PRICE_TO_USDC_LAMPORTS  // price 60 → 600_000 (= $0.60)
yes_seller_payout = fill_price_usdc                     // resting ask gets their price
no_seller_payout = USDC_LAMPORTS_PER_DOLLAR - fill_price_usdc  // taker gets the remainder
vault_debit = quantity                                  // exactly $1.00 per pair in token lamports
```
Define `PRICE_TO_USDC_LAMPORTS` as a named constant in `constants.rs` — do not use the literal `10_000` in matching engine code.

**Invariant check after merge/burn**: `vault.amount == (total_minted - total_redeemed) * 1_000_000`. This must hold after every merge/burn fill. If it doesn't, the matching engine has a bug — fail the transaction with `VaultBalanceMismatch`.

**Edge cases to test**:
- Fill at price 1: Yes seller gets $0.01, No seller gets $0.99
- Fill at price 99: Yes seller gets $0.99, No seller gets $0.01
- Fill at price 50: symmetric $0.50 / $0.50 split
- Partial fill: merge/burn applies only to the filled quantity, remainder stays on book
- Multiple merge/burns in one `place_order` call (sweeping across price levels): vault must decrement by total merged quantity across all fills

### Override Window Safety

`crank_cancel` is deliberately **not blocked** during the override window because escrow refunds are outcome-independent — a cancelled order returns the same asset (USDC, Yes, or No tokens) regardless of who won. The override window only blocks `redeem`, where the payout amount depends on the outcome.

**Required test cases (Stage 3C)**:
- [ ] `crank_cancel` succeeds during override window (within 1hr of settlement): orders cancelled, escrow returned correctly
- [ ] `crank_cancel` succeeds after override window expires: same behavior
- [ ] `redeem` winner/loser mode fails during override window with `RedemptionBlockedOverride`
- [ ] `redeem` pair burn mode succeeds during override window (outcome-independent)
- [ ] `redeem` winner/loser mode succeeds immediately after override window expires
- [ ] Admin overrides outcome during window → `redeem` after new deadline pays based on corrected outcome
- [ ] Admin overrides outcome during window while `crank_cancel` is in progress → crank unaffected (returns same assets regardless of outcome flip)


### Trade History & Event Storage
- **On-chain**: Anchor `emit!` events for every fill, cancel, settle, redeem. Events are in transaction logs.
- **Event indexer** (`services/event-indexer/`): Long-running service that watches `connection.onLogs(programId)` for Anchor events, parses them, and persists to a **SQLite database** (`events.db`). On startup, backfills missed events via `getSignaturesForAddress` (starting from last-processed signature checkpoint in the DB — incremental, not full rescan). Exposes a REST API consumed by the frontend History page and Settlement Analytics. Eliminates slow on-the-fly transaction parsing.
- **Storage**: SQLite via `better-sqlite3`. **Must enable WAL mode** (`PRAGMA journal_mode=WAL`) at startup — `better-sqlite3` is synchronous, so without WAL, long writes (batch backfill) block API reads. WAL allows concurrent readers during writes. Tables: `fills`, `settlements`, `cancels`, `redeems`, plus a `checkpoints` table (last processed tx signature per program). Queries use SQL filtering (market, type, date range, pagination) instead of scanning files. Atomic writes — no partial-file corruption risk. **Scaling path**: if API read latency exceeds 100ms under load, split into a writer process (log watcher → SQLite) and a read replica (periodic `VACUUM INTO` to a read-only copy served by the API). If write throughput becomes a bottleneck (unlikely at this event volume), migrate to PostgreSQL.
- **Railway deployment**: 1GB persistent volume attached to the `event-indexer` service, mounted at `/data`. SQLite DB at `/data/events.db`. Volume survives redeploys, restarts, and service rebuilds ($0.25/month). Volume is single-attach — only the event-indexer reads/writes the DB; frontend hits the indexer's REST API. Backfill runs once on first deploy; subsequent deploys resume from checkpoint.
- **Local development**: DB file at `data/events.db` (gitignored). Created automatically on first run.
- **Frontend History page**: Queries the event indexer via `/api/events/*` Next.js proxy routes. TanStack Query with polling. Falls back to direct `getSignaturesForAddress` parsing if indexer is down.
- **Settlement analytics (Phase 4)**: Settlement records also captured by the event indexer (SettlementEvent). Analytics components read from the same API. The indexer is the single source of truth for all historical events.

### Real-Time Updates
- **Order book + positions**: Solana `connection.onAccountChange(orderBookPDA)` WebSocket subscription — instant updates when any order is placed/filled/cancelled. Used alongside TanStack Query (polling as fallback).
- **Oracle prices**: `connection.onAccountChange(priceFeedPDA)` — live price updates from oracle feeder.
- **Tradier streaming**: `stream.tradier.com/v1/markets/events` for live intraday stock prices in the oracle feeder. Streaming doesn't count against rate limits. **Disconnect handling**: heartbeat timeout (no data for 30s during market hours → assume disconnected), exponential backoff reconnect (1s, 2s, 4s, … capped at 60s), automatic REST polling fallback (`/v1/markets/quotes` every 5s) while reconnecting. **Context-aware alerting**: if disconnect occurs within `CRITICAL_WINDOW_MINUTES = 30` minutes of market close, alert immediately (after 10s, not 60s) and skip backoff delay — fall back to REST polling at 5s interval without waiting. Outside the close window, alert after 60s as normal. Stale oracle prices near close risk failed settlements — the 30-minute window is the most critical period. Define `CRITICAL_WINDOW_MINUTES` as a named constant in the oracle feeder config.

### Prerequisites (README)
- Rust 1.94+ (tested with 1.94.0; Anchor 0.30.x requires 1.75+ minimum)
- Solana CLI 2.1+ (tested with 2.1.21; 1.18+ minimum for Anchor compatibility)
- Anchor CLI 0.30.1 (pinned — do not use 0.30.0 or 0.31.x)
- Node.js 24+ (tested with v24.11.1; 18+ minimum)
- Yarn 1.22+ (workspace-aware, consistent with Anchor ecosystem)
- Tradier API key (brokerage account, GET-only access)
- A Solana wallet (Phantom recommended for browser testing)

### Environment Variables

Two env file templates are committed. Copy the one matching your target:
- `cp .env.devnet.example .env` → local devnet development
- `cp .env.mainnet.example .env` → local mainnet development

**`.env.devnet.example`:**
```bash
# Network
NEXT_PUBLIC_SOLANA_NETWORK=devnet                     # Drives UI: faucet visibility, trade confirmations, explorer links
SOLANA_RPC_URL=https://api.devnet.solana.com
ANCHOR_WALLET=~/.config/solana/id.json               # Deployer/admin keypair
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com

# Program IDs (set after first deploy)
MERIDIAN_PROGRAM_ID=
MOCK_ORACLE_PROGRAM_ID=

# Token mints (set after create-mock-usdc.ts)
USDC_MINT=

# Tradier API
TRADIER_API_KEY=                                      # Brokerage API token
TRADIER_ACCOUNT_ID=                                   # Brokerage account ID
TRADIER_BASE_URL=https://api.tradier.com

# Frontend (prefixed for Next.js client-side access)
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_MERIDIAN_PROGRAM_ID=
NEXT_PUBLIC_MOCK_ORACLE_PROGRAM_ID=
NEXT_PUBLIC_USDC_MINT=

# Faucet (devnet only — USDC mint authority keypair, base58-encoded secret key)
FAUCET_KEYPAIR=

# Services
ORACLE_UPDATE_INTERVAL_MS=5000                        # Oracle feeder update frequency
AMM_SPREAD_BPS=200                                    # AMM bot spread (basis points)
AMM_MAX_INVENTORY=100                                 # AMM bot max position per side

# Monitoring (optional)
DISCORD_WEBHOOK_URL=                                  # Alert notifications
```

**`.env.mainnet.example`:**
```bash
# Network
NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta               # Enables: trade confirmations, risk disclaimers, funding guide. Disables: faucet.
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
ANCHOR_WALLET=~/.config/solana/mainnet-deployer.json  # Dedicated mainnet keypair — never reuse devnet key
ANCHOR_PROVIDER_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Program IDs (set after mainnet deploy)
MERIDIAN_PROGRAM_ID=
# No MOCK_ORACLE_PROGRAM_ID on mainnet — uses Pyth

# Token mints
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  # Real USDC on mainnet

# Pyth
PYTH_PROGRAM_ID=FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH

# Tradier API
TRADIER_API_KEY=                                      # Production brokerage API token
TRADIER_ACCOUNT_ID=
TRADIER_BASE_URL=https://api.tradier.com

# Frontend
NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
NEXT_PUBLIC_MERIDIAN_PROGRAM_ID=
NEXT_PUBLIC_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
NEXT_PUBLIC_PYTH_PROGRAM_ID=FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH

# No FAUCET_KEYPAIR on mainnet — faucet routes return 403

# Market Maker access control (mainnet only — comma-separated wallet addresses)
NEXT_PUBLIC_MM_WALLETS=

# Services
ORACLE_UPDATE_INTERVAL_MS=5000
AMM_SPREAD_BPS=200
AMM_MAX_INVENTORY=100

# Monitoring (required on mainnet)
DISCORD_WEBHOOK_URL=                                  # Alert notifications
HELIUS_API_KEY=                                       # For RPC + WebSocket
```

---

## Verification

1. `anchor test` — all smart contract tests pass locally
2. `deploy-devnet.sh` — both programs deploy to devnet
3. `scripts/create-mock-usdc.ts` — mock USDC mint created on devnet
4. `scripts/airdrop-usdc.ts` — test wallets funded with mock USDC
5. `init-config.ts` + `create-test-markets.ts` — markets appear on devnet
6. Oracle feeder running — Tradier prices flowing to on-chain oracle (WebSocket streaming)
7. Frontend: connect wallet, see USDC balance, browse markets, see live oracle prices
8. Place market order + limit order, see fills, see order book update in real-time (both views)
9. Buy No (market + limit variants), Sell No via `place_order(side=2)` No-backed bid
10. Position constraints: attempt Buy Yes while holding No → blocked with prompt
11. Settlement: countdown timer, settle via oracle, override window indicator, winning/losing display, redeem USDC after override window
12. AMM bot running — order books have liquidity
13. Analytics page shows Greeks, options comparison, historical overlay
14. Full lifecycle script: create -> mint -> trade -> settle -> crank_cancel -> redeem (vault empties to zero)
15. Post-settlement crank: `crank_cancel` clears all resting orders, escrow funds returned to owners
16. Add strike intraday via admin CLI
17. Settlement retries: simulate oracle failure, verify 30s retry for 15 min, then admin alert
18. Trade history: History page shows execution log from parsed tx events
