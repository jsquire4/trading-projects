# Meridian — Implementation Plan

Two workstreams: (A) Settlement-to-Init Pipeline and (B) Frontend Redesign.
These are independent — A is backend services, B is frontend. Can be worked in parallel.

---

## Part A: Settlement-to-Init Pipeline

Design principle: the platform manages itself end-to-end, day-to-day. No human in the loop for normal operations. All automation is self-healing with retries.

### A1. Oracle Feeder — Market State Monitor

**File:** `services/oracle-feeder/src/index.ts`

Add a `marketState` check to the oracle feeder's polling loop:
- Every 30s, call `getMarketClock()` alongside price updates
- Track the last known state. If it transitions from `REGULAR` to `CLOSED`/`POST`:
  - If **unexpected** (before any active market's `market_close_unix`) → call `pause` instruction on-chain, log alert, stop price updates
  - If **expected** (normal close) → stop price updates, settlement service handles the rest
- If state is not `REGULAR` (weekends, pre-market, holidays) → skip price updates, feeder idles
- On-chain `place_order` already enforces `clock < market_close_unix` — no arb gap possible regardless of feeder timing

### A2. Settlement Service — Reactive Trigger

**File:** `services/settlement/src/index.ts`

Replace one-shot execution with a long-running polling loop:
- Runs continuously, polls on-chain every 60s
- Each poll: fetch all `StrikeMarket` accounts, filter for `market_close_unix <= now && !is_settled`
- When expired markets found → confirm Yahoo `marketState` is `POST` or `CLOSED` → start settlement cycle
- If `market_close_unix` passed but Yahoo still says `REGULAR` → wait and alert (possible wrong close time)
- After settlement cycle completes (settle → crank → redeem → close → initNextDay → unpause), resume polling
- Replaces scheduler's `afternoon-settle` fixed-time job

### A3. Double-Confirm Price Logic

**File:** `services/settlement/src/index.ts` (new function)

Replace single `fetchClosingPrices` with double-confirm:
1. First poll: fetch quotes for all expired tickers, store `{ticker → price}`
2. Wait 5 minutes
3. Second poll: compare to first. Match → confirmed. Mismatch → wait, repeat.
4. Per-ticker settlement: settle each ticker as it confirms, don't hold confirmed tickers
5. 30-minute hard timeout → fall back to `admin_settle` with last known price, critical alert
6. `initNextDay` + `unpause` only fires after ALL tickers settled (or timed out)

### A4. Early Close Detection

**File:** `services/market-initializer/src/initializer.ts`

Update `computeMarketCloseUnix`:
- Check Yahoo `getMarketClock()` for session end time before defaulting to 4:00 PM
- If Yahoo indicates early close (1:00 PM) → use that
- Fall back to 4:00 PM if Yahoo unreachable
- Hardcoded NYSE holidays in `timezone.ts` remain as secondary fallback
- Known weakness: brittle for early closes. Will revisit with better calendar source later.

### A5. Settlement Service — Unpause After Init (Autonomous)

**File:** `services/settlement/src/index.ts`

Final step of `runSettlementCycle`:
- After `initNextDay()` succeeds → call `unpause` instruction
- Catch `NotPaused` (6024) → ignore (circuit breaker was never tripped, normal close)
- On RPC failure → retry with exponential backoff, 3-5 attempts
- Alert is informational only ("unpause took N retries"), not a request for intervention
- No manual fallback — retry is the only path, same as what admin would do manually

### A6. Scheduler Simplification

**File:** `services/automation/src/scheduler.ts`

Reduce to observe-only watchdog:
- **Remove** `morning-init` (8:00 AM) — market creation happens at end of settlement pipeline
- **Remove** `afternoon-settle` (4:05 PM) — settlement service is now a long-running poller
- **Remove** `afternoon-verify` (4:10 PM) — settlement service verifies its own pipeline
- **Keep** `morning-verify` (8:30 AM) renamed to "daily health check" — alert-only:
  - Are there active unsettled markets for today?
  - Is the oracle feeder process running?
  - Is the settlement service process running?
  - Alert if anything missing. Never blocks or modifies state.

### A7. Weekend/Holiday Trading Flow (Already Works)

No code changes needed:
- `computeMarketCloseUnix` scans forward to next trading day (skips weekends + holidays)
- Friday settlement → `initNextDay` creates Monday (or next trading day) markets
- Trading stays open all weekend against next-expiry markets
- Oracle prices freeze over weekend (feeder skips non-REGULAR state)
- On-chain `market_close_unix` is the only authority — countdown shows correct time regardless of day

### Settlement Timeline (Normal Day)

```
3:59:59 PM — last possible on-chain order (Solana clock enforces market_close_unix)
4:00:00 PM — market_close_unix hits, place_order rejects all new orders ON-CHAIN
4:00:01 PM — settlement service detects expired markets
             confirms Yahoo marketState == POST
4:00 PM    — first price poll
4:05 PM    — second price poll, compare — confirmed tickers settle immediately
4:05-4:10  — per-ticker: update oracle → settle → crank_cancel → auto_redeem → close
4:10 PM    — all settled → initNextDay (creates next trading day markets)
4:12 PM    — unpause (autonomous retry) → new markets live, trading resumes
```

### Settlement Timeline (Emergency Close at 2 PM)

```
2:00 PM    — oracle feeder detects CLOSED before market_close_unix
             trips circuit breaker → no new orders on our platform
             stops updating oracle prices
4:00 PM    — market_close_unix passes, settlement fires normally
             same double-confirm → settle → crank → redeem → close → init → unpause
```

---

## Part B: Frontend Redesign

### B1. `/trade` Page — Ticker Sidebar + Cards

**Files:** `app/meridian-web/src/app/trade/page.tsx`, new `components/TickerCard.tsx`

**Left sidebar** (replaces WatchlistStrip):
- Vertical ticker list, always visible
- MAG7 tickers always shown, custom tickers below divider
- Each entry: ticker symbol, price, change %
- Click to navigate to `/trade/[ticker]`
- "+ Add ticker" input at bottom
- Not scrollable unless list is long

**Main content area** — ticker cards:
- One card per ticker, ordered by aggregate open order volume
- Carry the shiny gradient/shimmer CTA style from analytics page cards
- Card shows: "Will AAPL close above $190?" with ATM strike, implied probability
- Two CTA buttons: [Buy Yes @ 62¢] [Buy No @ 38¢]
- Clicking CTA → navigates to `/trade/AAPL` with ATM strike selected, Order Modal pre-opened
- When no market exists: same shiny card, CTA triggers full creation bundle in modal
- Implied probability from best bid/ask; falls back to binary delta from greeks if no liquidity

**Bottom** — live fill ticker (FOMO feed):
- Horizontal scrolling: "AAPL $190 Yes ×50 @ 62¢ · 3s ago"
- Uses existing `useIndexedEvents` hook

**Remove:** `SummaryBar`, `TickerFilterTabs`, per-strike `MarketCard` grid

### B2. `/trade/[ticker]` Page — Full Redesign

**File:** `app/meridian-web/src/app/trade/[ticker]/page.tsx` (rewrite)

Layout top-to-bottom:

#### Analytics Banner
- Oracle price + change % (existing `OraclePrice`)
- Binary greeks: Δ, Γ, θ, Vega (existing `greeks.ts`)
- Distribution histogram with strike overlay (adapted from `HistoricalOverlay`)
- Settlement countdown
- `SettleButton` (permissionless)
- Remove forward projection (not useful for 0DTE)
- Mobile: stack, collapsible sections with show/hide

#### My Orders (Ticker-Level)
- Above strike tabs — shows all orders across ALL strikes for this ticker
- **Open Orders** (top, actionable): strike, side, price, implied probability, remaining/original qty, cancel button, Cancel All
- **Filled Today** (below, read-only): strike, side, price, implied probability, qty, time
- Clicking an open order highlights that level in the tree

#### Strike Tabs
- Horizontal tabs for each active strike
- `+ New Strike` — user selects strike price, tree shows empty 99 levels for that (not-yet-created) strike
- No separate `CreateMarketPanel` — creation bundled into Order Modal when user commits

#### Order Tree
**New file:** `components/OrderTree.tsx`

- Collapsed to levels with open interest by default
- Yes prices descending left (99→1), No prices ascending right (1→99)
- Each row: # orders, remaining qty, total historical volume
- Dynamic color intensity: most volume = most vibrant, least = faintest
- "Show all 99 levels" → full modal for makers posting at empty levels
- Click row → Order Modal (B3)
- For not-yet-created strikes: empty tree, all levels available, creation happens on commit

### B3. Order Modal

**New file:** `components/OrderModal.tsx`

Single point of commitment. Adapts based on what's needed:

**Taker filling existing orders:**
- Pre-filled side + price from clicked row
- Sweep preview across levels if qty > clicked level's available
- "Fill All" option
- Total cost, weighted avg price, implied probability

**Maker posting on existing strike:**
- Qty input, limit/market toggle
- Rent deposit if new slot needed
- Total escrow amount

**Maker on new strike (strike doesn't exist on-chain yet):**
- Bundles: `create_strike_market` → `place_order`
- Shows: market creation rent + slot rent + escrow

**Maker on new ticker (not in registry):**
- Full bundle: `add_ticker` → `initialize_feed` → `update_price` → `create_strike_market` → `place_order`
- All rent fees broken out + escrow amount

**Hybrid (partial fill + resting):**
- "X fills immediately ($Y), Z rests as limit order ($W escrowed)"

**All modes show before confirm:**
- Total cost (USDC)
- Weighted avg price
- Implied probability
- Rent deposits (itemized, only when needed)
- Confirm / Cancel

### B4. Custom Ticker/Strike Wiring

No longer a separate component. The flow:
- User adds ticker to watchlist sidebar (client-side only, localStorage, no rent)
- User clicks ticker → `/trade/[ticker]`
- If no markets exist, strike tabs show "+ New Strike" only
- User selects a strike, clicks a price level in the empty tree
- Order Modal detects what's needed (ticker registration? oracle feed? strike market?) and bundles it all
- One confirmation, one commit. No on-chain cost until the maker opens a slot.

`CreateMarketPanel` as a standalone component is removed. Its logic (oracle check, ticker validation, strike generation) is absorbed into the Order Modal's pre-flight checks.

### B5. Pair Burn → Portfolio

**File:** `components/portfolio/PositionsTab.tsx`

Per-strike position display:
- Shows Yes balance, No balance
- If both > 0: shows hedged pairs (min of two) with "Cash out $X USDC" button
- Shows net exposure after pair burn: "Net: 30 Yes (bullish)"
- Pair burn uses existing `useRedeem` hook with mode=0

Ticker-level summary:
- Aggregate across strikes: total invested, current value, net exposure
- Position shape indicator (bullish / bearish / range-bound / vol-long)

Supports all cross-strike strategies — portfolio just reports what's held, never restricts. Pair burn only within same strike (on-chain enforced).

Named strategy detection for common multi-strike patterns:
- **Corridor** (Yes at low strike + No at high strike) — range-bound bet, profits if price lands between
- **Strangle** (Yes at high strike + No at low strike) — volatility bet, profits on big move either way
- **Ladder** (Yes or No at multiple strikes) — scaled directional exposure
- Display aggregate payoff profile across all strikes for the ticker

Position constraint awareness:
- `ConflictingPosition` blocks holding both Yes and No on the SAME strike (by design, per-market check)
- Warn when an existing position blocks a new order on the same strike
- Cross-strike positions are unrestricted (different markets)
- Show when ring-fence check would block pair burn post-settlement (vault nearly drained)

### B6. Remove Deprecated Components

Remove from `/trade/[ticker]/page.tsx`:
- `OrderForm` (replaced by Order Modal)
- `RedeemPanel` (pair burn moved to portfolio)
- `FillFeed` (moved to `/trade` page as FOMO ticker)
- `DepthChart` (order tree replaces this)
- `OrderBook` component (order tree replaces this)
- `CreateMarketPanel` (absorbed into Order Modal)

Keep (adapted into analytics banner):
- `SettleButton`
- `MarketInfo` data

### B7. Versioned Transactions + ALT for Order Placement

**File:** `hooks/usePlaceOrder.ts`

Current `maxFills = 10` is a transaction size bottleneck. Each fill adds a maker ATA (32 bytes) to remaining_accounts, hitting Solana's 1232-byte tx limit at ~10 fills.

Fix: build versioned transactions using the market's existing ALT (`alt_address` on StrikeMarket):
- Look up market's ALT address
- Build `VersionedTransaction` with `MessageV0` + ALT instead of legacy `Transaction`
- ALT compresses each account ref from 32 bytes to 1 byte
- Raises practical max fills from ~10 to 50+
- `max_fills` parameter passed to on-chain instruction increases accordingly

### B8. `/admin` — Emergency + Treasury

**File:** `app/meridian-web/src/app/admin/page.tsx`

**Emergency Controls:**
- Pause / Unpause
- Circuit Breaker
- Admin Override Settlement
- Deactivate Ticker

**Treasury & Fee Management:**
- Adjust `fee_bps` (trading fee, max 10%)
- Adjust `strike_creation_fee`
- Adjust `slot_rent_markup`
- Adjust `operating_reserve`
- Withdraw USDC from Treasury (display: balance, obligations, available = balance - obligations)
- Withdraw SOL from SOL Treasury (display: balance, operating reserve, rent min, available)
- Estimated daily SOL costs (rent for ~35-42 markets × 8 accounts)

All withdrawal caps enforced on-chain — UI shows available balance clearly.

**Remove from admin:**
- `CreateMarketForm` (autonomous + permissionless now)
- `TickerManagement` "Add Ticker" (permissionless from order modal)

---

## Implementation Order

Phases 1 and 2 can run in parallel — no shared files between service layer and frontend.

### Phase 1 — Service Layer (Part A)

```
A1 (oracle feeder monitor) ──────────────────────┐
A4 (early close detection) ──────────────────────┐│
A2 (reactive trigger) → A3 (double-confirm) → A5 (unpause) → A6 (scheduler cleanup)
```

1. A2 — Settlement reactive trigger — core behavior change, everything chains from this
2. A3 — Double-confirm price logic — plugs into A2's settlement cycle
3. A1 — Oracle feeder market state monitor — independent, can parallel with A2/A3
4. A4 — Early close detection — independent, updates market-initializer
5. A5 — Unpause after init — final step of the pipeline A2 built
6. A6 — Scheduler simplification — cleanup, remove jobs A2 replaced

### Phase 2 — Frontend (Part B)

```
B7 (versioned tx + ALT) → B3 (order modal) → B4 (custom ticker wiring) ─┐
                           B2.tree (order tree) ─────────────────────────┤
                           B1 (trade page + sidebar) ────────────────────┼→ B2 (ticker page rewrite) → B6 (remove deprecated)
B5 (portfolio + strategies) ─────────────────────────────────────────────┘
B8 (admin treasury) ── independent
```

1. B7 — Versioned transactions + ALT — unblocks order modal sweep depth (10 → 50+)
2. B3 — Order Modal — core component, all order actions flow through it. Depends on B7.
3. B4 — Custom ticker/strike wiring — pre-flight checks absorbed into B3
4. B2.OrderTree — Order tree visualization — independent of B3, can parallel with B3/B4
5. B1 — `/trade` page: ticker sidebar + cards with ATM CTA + FOMO feed — independent, can parallel
6. B5 — Portfolio: pair burn + strategy detection + constraint warnings — independent, can parallel
7. B8 — Admin: emergency controls + treasury management — independent, can parallel
8. B2 — `/trade/[ticker]` full page rewrite — depends on B3, B4, OrderTree, B1 sidebar
9. B6 — Remove deprecated components — after B2 page rewrite is complete

**Parallelizable groups:**
- Group 1: B7 → B3 → B4 (sequential, order modal chain)
- Group 2: B2.OrderTree, B1, B5, B8 (all independent, can run alongside Group 1)
- Group 3: B2 page rewrite (needs Group 1 + Group 2 outputs)
- Group 4: B6 cleanup (after Group 3)

### Phase 3 — Integration & Testing
1. E2E stress test update (new order modal flow, versioned transactions)
2. Frontend build verification
3. Service integration test (settlement → init → unpause cycle)
4. Manual QA: full flow from add ticker → create strike → place order → settlement → next day

---

## Definition of Done

- [ ] Settlement fires reactively when markets expire, not at fixed 4:05 PM
- [ ] Double-confirm price logic prevents settling on stale/inconsistent prices
- [ ] Oracle feeder trips circuit breaker on unexpected market close
- [ ] Settlement service unpauses autonomously after creating next-day markets
- [ ] Early close days handled via Yahoo marketState
- [ ] `/trade` shows ticker sidebar + ticker-level cards with ATM CTA
- [ ] Ticker cards use shiny gradient/shimmer style from analytics page
- [ ] `/trade/[ticker]` has analytics banner, my orders, strike tabs, order tree
- [ ] Clicking a tree row opens confirmation modal with sweep preview + Fill All
- [ ] Order Modal bundles ticker registration + market creation + order placement in one confirm
- [ ] No on-chain costs until maker commits (watchlist + strike selection are client-side)
- [ ] Custom tickers/strikes auto-register on-chain when maker opens a slot
- [ ] Pair burn on portfolio page with hedged pairs display + net exposure
- [ ] Cross-strike strategies supported (no UI restrictions on position combinations)
- [ ] `/admin` has emergency controls + treasury/fee management with available balance display
- [ ] Live fill ticker on `/trade` page (FOMO feed)
- [ ] Versioned transactions with ALT for order placement (max fills 50+, not 10)
- [ ] Portfolio detects named strategies (corridor, strangle, ladder)
- [ ] Position constraint warnings when existing holdings block new orders
- [ ] Order modal shows expected fill depth for sweeps
- [ ] 167 on-chain tests still pass
- [ ] Frontend builds clean
- [ ] E2E stress test passes
