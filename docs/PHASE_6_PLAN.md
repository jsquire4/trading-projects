# Phase 6: Admin Platform + Sparse Order Book + Service Migration

## Overview

Five phases transforming Meridian from a developer-operated prototype into a self-service platform manageable entirely from the browser. Includes on-chain admin instructions, dynamic order book architecture, Tradier→Yahoo Finance migration, and comprehensive testing.

**Dependency graph:**
```
6A (on-chain admin) ──→ 6B (frontend dashboard)
         │                        │
         │               6C (Yahoo migration) ← independent
         │
         └──→ 6D (sparse order book + /rules) ──→ 6E (E2E stress test)
```

Phases 6A and 6C can run in parallel. 6B requires 6A (needs updated IDL). 6D requires 6A (TickerRegistry in create_strike_market). 6E validates everything.

---

## Phase 6A: On-Chain Admin Instructions + TickerRegistry + GlobalConfig Expansion

### Goal
Add 9 new instructions, a TickerRegistry PDA, and expand GlobalConfig with new fields. This unlocks admin key transfer, fee/treasury withdrawal, config updates, circuit breaker, and mock oracle safety gate.

### New Instructions

| # | Instruction | Purpose | Key constraint |
|---|---|---|---|
| 1 | `transfer_admin` | Propose new admin (sets pending_admin) | Admin signer |
| 2 | `accept_admin` | Pending admin accepts authority | pending_admin signer |
| 3 | `withdraw_fees` | Drain fee_vault to admin ATA | Admin signer, balance > 0 |
| 4 | `withdraw_treasury` | Withdraw surplus from treasury | `amount <= balance - obligations - operating_reserve` |
| 5 | `update_config` | Update staleness, confidence, oracle_type, operating_reserve, blackout_minutes | Admin signer; Pyth→Mock blocked if unsettled markets exist |
| 6 | `add_ticker` | Add entry to TickerRegistry (realloc) | Admin signer |
| 7 | `deactivate_ticker` | Set is_active=false on a TickerEntry | Admin signer |
| 8 | `circuit_breaker` | Mass pause + crank cancel resting orders | Admin signer; accepts market batch via remaining_accounts |
| 9 | `expand_config` | One-time migration: realloc GlobalConfig 192→248 bytes | Admin signer; idempotent |

### State Changes

**GlobalConfig expansion** (append to preserve existing field offsets):
```
pending_admin: Pubkey           (+32 bytes)
operating_reserve: u64          (+8 bytes)
obligations: u64                (+8 bytes)
settlement_blackout_minutes: u16 (+2 bytes)
_padding2: [u8; 6]             (+6 bytes)
New LEN = 248 (was 192)
```

**New TickerRegistry PDA** (seeds: `["tickers"]`):
```
TickerRegistry {
    bump: u8,
    count: u8,
    _padding: [u8; 6],
    entries: [TickerEntry; N],  // grows via realloc
}
TickerEntry {
    ticker: [u8; 8],
    is_active: bool,
    _padding: [u8; 7],
}   // 16 bytes per entry
```

**Modified existing instructions:**
- `create_strike_market`: validate ticker against TickerRegistry instead of `config.tickers`
- `mint_pair` + `place_order`: require admin signer when `config.oracle_type == 0` (Mock)
- `close_market`: increment `config.obligations` by vault sweep amount
- `treasury_redeem`: decrement `config.obligations` by payout amount

### New Files
```
programs/meridian/src/state/ticker_registry.rs
programs/meridian/src/instructions/transfer_admin.rs
programs/meridian/src/instructions/accept_admin.rs
programs/meridian/src/instructions/withdraw_fees.rs
programs/meridian/src/instructions/withdraw_treasury.rs
programs/meridian/src/instructions/update_config.rs
programs/meridian/src/instructions/add_ticker.rs
programs/meridian/src/instructions/deactivate_ticker.rs
programs/meridian/src/instructions/circuit_breaker.rs
programs/meridian/src/instructions/expand_config.rs
tests/meridian/admin-v2.test.ts
```

### Modified Files
```
programs/meridian/src/state/config.rs          — new fields, update LEN
programs/meridian/src/state/mod.rs             — export TickerRegistry
programs/meridian/src/error.rs                 — ~10 new error codes
programs/meridian/src/instructions/mod.rs      — export 10 new modules
programs/meridian/src/lib.rs                   — dispatch for 10 new instructions
programs/meridian/src/instructions/create_strike_market.rs — TickerRegistry validation
programs/meridian/src/instructions/mint_pair.rs — Mock oracle gate
programs/meridian/src/instructions/place_order/mod.rs — Mock oracle gate
programs/meridian/src/instructions/close_market.rs — obligations tracking
programs/meridian/src/instructions/treasury_redeem.rs — obligations tracking
services/shared/src/pda.ts                     — add findTickerRegistry()
tests/helpers/instructions.ts                  — 10 new build*Ix functions
```

### Implementation Order
```
1. state/ticker_registry.rs        (no deps)
2. state/config.rs                 (add fields, update LEN)
3. error.rs                        (new codes)
4. instructions/expand_config.rs   (migration instruction)
5. instructions/transfer_admin.rs + accept_admin.rs
6. instructions/add_ticker.rs + deactivate_ticker.rs
7. instructions/update_config.rs
8. instructions/withdraw_fees.rs + withdraw_treasury.rs
9. instructions/circuit_breaker.rs
10. Modify create_strike_market.rs (TickerRegistry)
11. Modify mint_pair.rs + place_order (Mock gate)
12. Modify close_market.rs + treasury_redeem.rs (obligations)
13. lib.rs + mod.rs (wire everything)
14. services/shared/src/pda.ts (findTickerRegistry)
15. tests/helpers/instructions.ts (new builders)
16. tests/meridian/admin-v2.test.ts (all on-chain tests)
```

### On-Chain Tests (admin-v2.test.ts)

**transfer_admin:**
- Happy: propose → accept → new admin works, old admin rejected
- Error: non-admin proposes → rejected
- Error: wrong wallet accepts → rejected
- Edge: propose overwrites previous pending_admin

**withdraw_fees:**
- Happy: fee vault has balance → drain to admin ATA
- Error: non-admin → rejected
- Accounting: partial withdraw, verify residual

**withdraw_treasury:**
- Happy: withdraw within free balance → succeeds
- Error: withdraw > (balance - obligations - reserve) → rejected
- Invariant: treasury_balance >= obligations always holds

**update_config:**
- Happy: each field updated and readable
- Error: Pyth→Mock with unsettled markets → rejected
- Error: confidence_bps > 10000 → rejected

**TickerRegistry:**
- Happy: add 7 tickers, verify count and entries
- Error: duplicate ticker → rejected
- Deactivate: ticker becomes invalid for create_strike_market

**circuit_breaker:**
- Happy: 3 markets, resting orders → all paused, escrow returned
- Invariant: total escrow before == total returned
- Error: non-admin → rejected

**Mock oracle gate:**
- oracle_type=0: non-admin place_order → rejected; admin → succeeds
- oracle_type=1: anyone can place_order

### Acceptance Criteria
- [ ] All 10 new instruction happy paths pass in bankrun
- [ ] All admin-check error paths produce correct error codes
- [ ] GlobalConfig realloc works (192→248) without data corruption
- [ ] TickerRegistry replaces config.tickers for market creation validation
- [ ] Mock oracle gate blocks non-admin on mint_pair and place_order
- [ ] Obligations tracking: close_market increments, treasury_redeem decrements
- [ ] Circuit breaker returns all escrowed funds atomically
- [ ] `anchor build` succeeds, IDL generated with new instructions

---

## Phase 6B: Frontend Admin Dashboard

### Goal
Replace the basic admin page with a full operational dashboard: 5 tabs covering platform overview, fee management, markets, settings, and ticker management. Gated to admin wallet.

### New Components

| Component | Tab | What it shows/does |
|---|---|---|
| `AdminOverview.tsx` | Overview | SOL/USDC balances, fee_vault balance, treasury balance, obligations, operating_reserve, global pause, oracle type, active market count |
| `FeesRevenue.tsx` | Fees | Current fee_bps + strike_creation_fee with edit forms, fee_vault balance with withdraw button, available amount calculation |
| `MarketsPanel.tsx` | Markets | All markets with settle/pause/override/close/cleanup actions + circuit breaker button |
| `PlatformSettings.tsx` | Settings | Transfer admin (propose/accept), update_config forms (staleness, confidence, oracle type, blackout), global pause toggle |
| `TickerManagement.tsx` | Tickers | List tickers from TickerRegistry, add form, deactivate buttons |

### New Hooks

| Hook | Returns |
|---|---|
| `useGlobalConfig` | Parsed GlobalConfig with all new fields (pending_admin, obligations, operating_reserve, etc.) |
| `useFeeVaultBalance` | Fee vault SPL token balance |
| `useTreasuryBalance` | Treasury SPL token balance |
| `useTickerRegistry` | Parsed TickerEntry[] from TickerRegistry PDA |

### New Files
```
app/meridian-web/src/hooks/useGlobalConfig.ts
app/meridian-web/src/hooks/useFeeVaultBalance.ts
app/meridian-web/src/hooks/useTreasuryBalance.ts
app/meridian-web/src/hooks/useTickerRegistry.ts
app/meridian-web/src/components/admin/AdminOverview.tsx
app/meridian-web/src/components/admin/FeesRevenue.tsx
app/meridian-web/src/components/admin/MarketsPanel.tsx
app/meridian-web/src/components/admin/PlatformSettings.tsx
app/meridian-web/src/components/admin/TickerManagement.tsx
app/meridian-web/src/components/__tests__/AdminDashboard.test.tsx
app/meridian-web/src/components/__tests__/FeeManagement.test.tsx
app/meridian-web/src/components/__tests__/TreasuryPanel.test.tsx
```

### Modified Files
```
app/meridian-web/src/app/admin/page.tsx        — 5-tab layout
app/meridian-web/src/components/admin/CreateMarketForm.tsx — ticker source from TickerRegistry
app/meridian-web/src/lib/pda.ts                — re-export findTickerRegistry
app/meridian-web/src/idl/meridian.ts + .json   — regenerated after 6A
```

### Implementation Order
```
1. Regenerate IDL (anchor build after 6A)
2. pda.ts — add findTickerRegistry re-export
3. useGlobalConfig → useFeeVaultBalance → useTreasuryBalance → useTickerRegistry
4. AdminOverview (depends on all hooks)
5. FeesRevenue (depends on useGlobalConfig, useFeeVaultBalance)
6. PlatformSettings (depends on useGlobalConfig)
7. TickerManagement (depends on useTickerRegistry)
8. MarketsPanel (refactors existing MarketActions)
9. admin/page.tsx — tab shell
10. CreateMarketForm — swap hardcoded tickers for useTickerRegistry
11. Frontend tests (mission-critical flows)
```

### Frontend Tests (mission-critical only)
- Admin wallet gate: non-admin sees nothing, admin sees full UI
- Fee withdrawal: button fires correct instruction, balance updates
- Treasury withdrawal: amount > free balance → button disabled
- Config updates: validation prevents out-of-range values

### Design Conventions
Follow existing patterns:
- Cards: `rounded-lg border border-white/10 bg-white/5 p-4 space-y-3`
- Section titles: `text-sm font-semibold text-white/80`
- Buttons: `bg-accent/20 hover:bg-accent/30 text-white rounded-md py-2.5 text-sm font-semibold`
- Destructive: `bg-red-500/20 text-red-400 hover:bg-red-500/30`
- Loading state: `submitting: string | null` per action
- Tx pattern: `program.methods.X().accountsPartial().transaction()` → `sendTransaction(tx, {description})`

### Acceptance Criteria
- [ ] Non-admin wallet → no admin UI rendered (no information leakage)
- [ ] All 5 tabs render without errors with admin wallet connected
- [ ] Fee withdrawal flow: button → loading → success toast → balance refreshed
- [ ] Treasury withdrawal: frontend guard rejects overdraws before tx sent
- [ ] Config update forms validate inputs (ranges, non-empty) before tx
- [ ] Circuit breaker button: confirmation dialog → mass pause + cancel
- [ ] Transfer admin: propose → shows pending state → accept clears it
- [ ] "Not initialized" state: shows CLI instructions when no GlobalConfig exists

---

## Phase 6C: Tradier → Yahoo Finance Migration

### Goal
Replace all Tradier dependencies with Yahoo Finance (free, no API key). Remove OptionsComparison, GreeksDisplay, and all Tradier-specific code.

### New Files
```
services/shared/src/yahoo-client.ts            — implements IMarketDataClient
services/shared/src/__tests__/yahoo-client.test.ts
```

### Deleted Files
```
services/shared/src/tradier-client.ts
services/shared/src/__tests__/tradier-client.test.ts (if exists)
app/meridian-web/src/lib/tradier-proxy.ts
app/meridian-web/src/app/api/tradier/quotes/route.ts
app/meridian-web/src/app/api/tradier/history/route.ts
app/meridian-web/src/app/api/tradier/options/route.ts
app/meridian-web/src/app/api/tradier/expirations/route.ts
app/meridian-web/src/components/analytics/OptionsComparison.tsx
app/meridian-web/src/components/analytics/GreeksDisplay.tsx
app/meridian-web/src/components/analytics/OptionsChainTable.tsx (if exists)
```

### Modified Files
```
services/shared/src/market-data.ts             — factory returns YahooClient
services/oracle-feeder/src/feeder.ts           — remove WebSocket, add REST polling
services/oracle-feeder/src/index.ts            — use factory
app/meridian-web/src/lib/market-data-proxy.ts  — point to Yahoo
app/meridian-web/src/hooks/useAnalyticsData.ts — remove Tradier hooks
app/meridian-web/src/app/analytics/page.tsx    — remove deleted components
.env.example                                    — remove TRADIER_API_KEY
```

### Yahoo Finance Client
Implements `IMarketDataClient` using `yahoo-finance2` npm package:
- `getQuotes(symbols)` → `yahoo.quote(symbols)` — provides last, prevclose, change
- `getHistory(symbol, interval, start, end)` → `yahoo.chart(symbol, {period1, period2})` — OHLCV bars
- `getMarketClock()` → derive from quote `marketState` field
- `getOptionsChain()` → throws `UnsupportedOperationError` (callers removed)

Oracle feeder switches from WebSocket streaming to REST polling every 5-30 seconds (configurable via `ORACLE_POLL_INTERVAL_MS` env var).

### Settler Fallback Chain
```
1. Pyth on-chain feed    → settle_market (permissionless)
2. Yahoo Finance REST    → settler calls admin_settle with Yahoo closing price
3. Admin manual entry    → admin panel button
4. Void 50/50            → absolute last resort
```

### Implementation Order
```
1. npm install yahoo-finance2
2. yahoo-client.ts (implements IMarketDataClient)
3. yahoo-client.test.ts (interface compliance)
4. market-data.ts factory update
5. oracle-feeder migration (WebSocket → polling)
6. settler fallback chain update
7. New /api/market-data/* routes (or update existing proxy)
8. Frontend hook updates (remove Tradier refs)
9. analytics/page.tsx — remove deleted components
10. Delete all Tradier files
11. .env.example cleanup
```

### Tests
- `YahooClient` unit tests: interface compliance, error handling, rate limit behavior
- Factory toggle: `MARKET_DATA_SOURCE=yahoo` → returns YahooClient
- Regression: `synthetic` mode unchanged
- Oracle feeder: mock client returns known prices → verify correct update_price ix built

### Acceptance Criteria
- [ ] `YahooClient` passes all `IMarketDataClient` interface tests
- [ ] Oracle feeder starts and pushes prices with Yahoo client (no Tradier)
- [ ] Market initializer reads prev close from Yahoo for strike calculation
- [ ] Settler fallback: Pyth stale → Yahoo price used via admin_settle
- [ ] No remaining imports of `tradier` anywhere in codebase (grep verification)
- [ ] `TRADIER_API_KEY` absent from .env doesn't break anything
- [ ] Existing synthetic mode works unchanged

---

## Phase 6D: Sparse Order Book Refactor + /rules Page

### Goal
Replace the fixed 254KB ZeroCopy order book with a dynamic sparse layout. Books start near-empty, grow inline on place_order (user pays rent), shrink on cancel. Remove allocate_order_book instruction entirely.

### New Order Book Layout

Manual byte layout via `UncheckedAccount` (not ZeroCopy):

```
Header (168 bytes, fixed):
  [0..8]     discriminator
  [8..40]    market: Pubkey
  [40..48]   next_order_id: u64
  [48..147]  price_map: [u8; 99]    // price → level_index (0xFF = unallocated)
  [147]      level_count: u8         // active levels
  [148]      max_levels: u8          // allocated capacity
  [149]      orders_per_level: u8    // slots per level (grows via realloc)
  [150]      bump: u8
  [151..168] _reserved

Level entry (8 + orders_per_level × 112 bytes each):
  [0]   price: u8
  [1]   count: u8       // active orders in this level
  [2..8] _padding
  [8..] orders: [OrderSlot; orders_per_level]

OrderSlot (112 bytes — was 80, +32 for rent_depositor):
  [0..32]    owner: Pubkey
  [32..40]   order_id: u64
  [40..48]   quantity: u64
  [48..56]   original_quantity: u64
  [56]       side: u8
  [57..64]   _side_padding
  [64..72]   timestamp: i64
  [72]       is_active: u8
  [73..80]   _padding
  [80..112]  rent_depositor: Pubkey   // NEW: who to return rent to
```

**Initial account size** (empty book): 8 + 168 = 176 bytes ≈ 0.002 SOL rent

**Per-level cost** (4 initial slots): 8 + 4 × 112 = 456 bytes ≈ 0.004 SOL rent

### Matching Engine Changes
- Walk `price_map[0..99]` instead of fixed level array
- For bids (descending): scan price_map from 98→0, skip 0xFF entries
- For asks (ascending): scan price_map from 0→98, skip 0xFF entries
- At each active level: same FIFO scan for lowest timestamp (unchanged logic)
- Level lookup: `O(1)` via `price_map[price - 1]` instead of direct array index

### place_order Inline Realloc Flow
```
1. Check price_map[price - 1]
2. If 0xFF (no level): allocate new level
   a. If level_count == allocated capacity: realloc account (add N levels)
   b. Find free level slot (scan for unused)
   c. Set price_map[price - 1] = slot_index
   d. Transfer rent from user → order_book account
   e. Resize account
3. Find free order slot in level (scan for is_active == 0)
4. If no free slots: realloc to add more slots per level
   a. Transfer additional rent from user
   b. Resize + zero new bytes
5. Write order, set rent_depositor = user pubkey
```

### cancel_order Rent Return Flow
```
1. Find order in level, zero the slot, decrement count
2. Set order.rent_depositor → return rent proportional to slot
3. If level.count == 0: free the level
   a. Set price_map[price - 1] = 0xFF
   b. Decrement level_count
   c. Return level rent to last order's rent_depositor
```

### StrikeMarket Change
Add `creator: Pubkey` field (+32 bytes, LEN 400→432) to track who to return market-level rent to on close_market.

### On-Chain File Changes

**New files:**
```
(none — order_book.rs is rewritten in place)
```

**Deleted files:**
```
programs/meridian/src/instructions/allocate_order_book.rs
```

**Modified files:**
```
programs/meridian/src/state/order_book.rs      — complete rewrite (sparse layout)
programs/meridian/src/state/strike_market.rs   — add creator field
programs/meridian/src/matching/engine.rs       — use price_map for level lookup
programs/meridian/src/instructions/place_order/mod.rs — inline realloc, rent deposit
programs/meridian/src/instructions/cancel_order.rs — rent return, level freeing
programs/meridian/src/instructions/close_market.rs — return all rent deposits
programs/meridian/src/instructions/create_strike_market.rs — init small book (176 bytes)
programs/meridian/src/instructions/crank_cancel.rs — sparse iteration + rent returns
programs/meridian/src/instructions/mod.rs      — remove allocate_order_book
programs/meridian/src/lib.rs                   — remove allocate_order_book dispatch
```

**Frontend files:**
```
app/meridian-web/src/lib/orderbook.ts          — rewrite deserializer for sparse layout
app/meridian-web/src/lib/__tests__/orderbook.test.ts — new test data for sparse format
app/meridian-web/src/app/rules/page.tsx        — NEW: static rules/ToS page
app/meridian-web/src/app/layout.tsx            — add Rules nav link
```

**Service files (Anchor IDL deserialization auto-updates after anchor build):**
```
services/amm-bot/src/executor.ts              — may need manual update if ZeroCopy removal breaks IDL fetch
services/settlement/src/cranker.ts            — same
services/settlement/src/closer.ts             — same
```

### /rules Page Content
Static page covering:
- How binary contracts work ($1 payout invariant)
- Settlement: at actual closing price, regardless of close time
- Early close / circuit breaker: resting orders cancelled, settle at closing price
- Oracle failure cascade: Pyth → Yahoo → admin manual → void 50/50 (last resort)
- Void: only if no price available; each side receives $0.50
- Rent deposits: users pay per order, returned on cancel/fill/settlement
- Fees: protocol fee on fills (fee_bps), strike creation fee for user-created markets
- Admin override: max 3 per market, each extends the window
- Settlement blackout: configurable window, no market creation during settlement

### Implementation Order
```
1. state/order_book.rs rewrite (foundation)
2. matching/engine.rs rewrite (depends on new layout)
3. create_strike_market.rs (init small book)
4. place_order/mod.rs (realloc + rent deposit)
5. cancel_order.rs (rent return + level freeing)
6. crank_cancel.rs (sparse iteration)
7. close_market.rs (return all rent deposits)
8. strike_market.rs (add creator field)
9. Delete allocate_order_book.rs, update mod.rs + lib.rs
10. On-chain tests: tests/meridian/sparse-order-book.test.ts
11. Frontend: orderbook.ts rewrite + tests
12. Frontend: /rules page
13. Service files: verify Anchor IDL fetch still works
```

### On-Chain Tests (sparse-order-book.test.ts)

**Initialization:**
- Book created at 176 bytes with zero levels
- price_map all 0xFF

**place_order + realloc:**
- Order at new price level → account grows, user SOL decreases by rent
- Second order at same price → no realloc (slot available)
- Market order that fills immediately → no rent charged (nothing rests)
- User has insufficient SOL for rent → transaction rejected

**cancel_order + rent return:**
- Cancel only order at a level → level freed, rent returned
- Cancel one of two orders at a level → level stays, slot rent returned
- Rent return amount == original deposit amount (exact lamport match)

**Rent accounting invariant (CRITICAL):**
```
1. Record order_book lamports before all orders
2. Place N orders across M levels
3. Cancel/fill/settle all orders
4. Assert: order_book lamports == initial value
5. Assert: sum(user deposits) == sum(user returns)
```
Run for: pure-cancel, fill-to-empty, and settlement-crank scenarios.

**Matching engine with sparse levels:**
- Price-time priority preserved with sparse levels
- Cross-level matching: taker matches best prices first
- Level removal during fill → level freed correctly
- Empty book → no fills, no crash

**Boundary conditions:**
- Max levels allocated → next new-level order rejected
- All levels freed → book returns to minimum size
- Level created, freed, re-created at same price → works correctly

### Acceptance Criteria
- [ ] Rent invariant: total deposited == total returned across full lifecycle
- [ ] Matching engine produces identical fill sequences (regression test with fixed seed)
- [ ] allocate_order_book completely removed (grep verification)
- [ ] Market creation produces 176-byte book (not 254KB)
- [ ] place_order at new price: account grows, user charged rent
- [ ] cancel_order at empty level: level freed, rent returned
- [ ] close_market: all remaining rent deposits returned
- [ ] TS deserializer handles: empty book, single level, many levels, partial fills
- [ ] /rules page renders with all required content sections
- [ ] No hardcoded references to 254,280 or MAX_ORDERS_PER_LEVEL=32 remain

---

## Phase 6E: E2E Stress Test Updates

### Goal
Update the stress test for all Phase 6A+6D changes: new instructions, sparse book, rent tracking, circuit breaker scenario.

### Modified Files
```
scripts/e2e-stress-test/config.ts              — remove alloc constants, add rent tracking
scripts/e2e-stress-test/types.ts               — add rentDeposited/rentReturned to AgentState
scripts/e2e-stress-test/helpers.ts             — rewrite parseOrderBook + SM offsets
scripts/e2e-stress-test/setup.ts               — initialize TickerRegistry, rent tracking
scripts/e2e-stress-test/act1-correctness.ts    — remove alloc loops, add 6A ix coverage
scripts/e2e-stress-test/act2-user-flows.ts     — remove alloc, add T9-T13
scripts/e2e-stress-test/act3-simulation.ts     — remove alloc, add circuit breaker + rent tracking
scripts/e2e-stress-test/agents/market-maker.ts — remove alloc loop
scripts/e2e-stress-test/agents/directional.ts  — remove alloc loop
scripts/e2e-stress-test/agents/scalper.ts      — remove alloc loop
scripts/e2e-stress-test/agents/strike-creator.ts — remove alloc loop
scripts/e2e-stress-test/verification.ts        — add rent accounting invariant
scripts/e2e-stress-test/index.ts               — update acceptance criteria
scripts/e2e-stress-test/report-template.ts     — update KNOWN_INSTRUCTIONS
tests/helpers/instructions.ts                  — add 10 new builders, remove allocate_order_book
```

### New Act 2 Smoke Tests

| # | Name | What it tests |
|---|---|---|
| T9 | Transfer admin two-step | Propose → accept → new admin works → transfer back |
| T10 | Withdraw fees | Place fills to accumulate fees → withdraw → verify |
| T11 | Treasury free-balance guard | Mint tokens → treasury has obligations → over-withdraw blocked → redeem → withdraw succeeds |
| T12 | Circuit breaker halts trading | Place orders → circuit_breaker → orders cancelled + pause → unpause → resume |
| T13 | Update config | Change staleness → verify → restore |

### Act 3 Circuit Breaker Scenario
Mid-simulation, inject a circuit_breaker call against one day's markets. Verify all orders cancelled, pause set. Unpause and resume trading. Track in metrics.

### Updated Acceptance Criteria

| ID | Description | New Threshold |
|---|---|---|
| AC-01 | Instruction types exercised | `>= 30` (was 22) |
| AC-10 | Act 2 smoke tests | `13/13 PASS` (was 8/8) |
| AC-11 (new) | Rent deposit accounting | `0 violations` (deposits == returns) |

### Updated KNOWN_INSTRUCTIONS
Add: `transfer_admin`, `accept_admin`, `withdraw_fees`, `withdraw_treasury`, `update_config`, `add_ticker`, `deactivate_ticker`, `circuit_breaker`, `expand_config`
Remove: `allocate_order_book`

### Acceptance Criteria
- [ ] All 13 Act 2 smoke tests pass
- [ ] AC-01 shows >= 30 instruction types
- [ ] AC-11 shows 0 rent accounting violations
- [ ] parseOrderBook works with sparse layout
- [ ] No references to ALLOC_CALLS_REQUIRED or allocate_order_book remain
- [ ] Report template lists all new instruction names
- [ ] Circuit breaker exercised at least once in Act 3

---

## Cross-Phase Notes

### Breaking Change (Phase 6D)
The sparse order book is a breaking layout change — old and new books cannot coexist. Deploy sequence:
1. Settle and close all markets on old program
2. Deploy updated program
3. Re-initialize config + TickerRegistry
4. Market-initializer creates fresh markets with sparse books

### CLI Script (Phase 6A)
`scripts/initialize-platform.ts` — one-time CLI for:
1. Deploy program (or verify deployed)
2. Call initialize_config (admin = signer, USDC mint, oracle program, thresholds)
3. Call expand_config (realloc to new size)
4. Call add_ticker × 7 (MAG7)
5. Initialize oracle feeds

### Market-Initializer Updates
After Phase 6D, the market-initializer service must:
- Remove all allocate_order_book calls (25-call loop eliminated)
- Use N(d2) probability to determine which price levels to pre-allocate on admin-created markets
- Pre-allocation is optional — levels can also be created on-demand by first orders

### Error Handling Strategy
- New on-chain errors: use 6150–6169 range to avoid collision with existing 6000–6141
- Frontend: all admin tx errors surface via existing sonner toast (useTransaction handles this)
- Circuit breaker: if batch too large for single tx, split across multiple txs (frontend handles batching)
- Rent realloc: if user SOL insufficient, return clear error before any state change

### Commit Strategy
One commit per phase, each passing all existing + new tests:
- 6A: `feat(on-chain): admin instructions, TickerRegistry, GlobalConfig expansion`
- 6B: `feat(frontend): admin dashboard with 5-tab operational panel`
- 6C: `refactor: replace Tradier with Yahoo Finance, remove options analytics`
- 6D: `feat(on-chain): sparse order book with user-paid rent deposits`
- 6E: `feat(e2e): stress test coverage for Phase 6 features`
