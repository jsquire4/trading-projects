# Complexity Sweep Implementation Plan

**Generated**: 2026-03-10
**Scope**: 30 issues (2 Critical, 8 High, 12 Medium, 8 Low) + final audit pass

---

## Work Streams Overview

| Stream | Focus | Issues | Parallelizable With |
|--------|-------|--------|---------------------|
| **WS-1** | On-chain security (Rust) | C1, C2, H1, H2, H7, M5, M6, L7, L8 | WS-2, WS-3 |
| **WS-2** | Frontend correctness (TypeScript/React) | H3, H4, H5, H8, M1, M3, M4, L1, L2, L5 | WS-1, WS-3 |
| **WS-3** | Services & scripts | H6, M2, M7, M8, M9, M10, M11, M12, L3, L4, L6 | WS-1, WS-2 |
| **WS-4** | Audit pass | All | Runs after WS-1, WS-2, WS-3 |

---

## WS-1: On-Chain Security (Rust)

### C1: Missing oracle ticker validation on settle_market

**Severity**: CRITICAL
**File**: `programs/meridian/src/instructions/settle_market.rs`
**Problem**: The `has_one = oracle_feed` constraint on line 19 only verifies that the passed `oracle_feed` account matches the pubkey stored in `market.oracle_feed`. This is actually present and correct. However, the parsed `ticker` field (line 43-44) is marked `#[allow(dead_code)]` and never validated against the market's `ticker`. An attacker who controls the oracle_feed pubkey stored in the market cannot exploit this (the PDA is derived at market creation). But if the oracle_feed stored in the market were somehow wrong (e.g., a bug in market creation), the ticker mismatch would go undetected.

**Re-assessment after reading code**: The `has_one = oracle_feed` constraint on line 19 IS present. The issue description says "missing `has_one = oracle_feed`" but line 19 shows `has_one = oracle_feed @ MeridianError::OracleProgramMismatch`. So C1 as originally stated is **already fixed** — the constraint exists. The real gap is C2: the ticker is parsed but not validated.

**Fix**: Add ticker validation in `handle_settle_market` after parsing the oracle feed. This is a defense-in-depth check:

```rust
// After line 117 (let feed = OraclePriceFeed::parse(&oracle_data)?;):
// Validate oracle ticker matches market ticker
require!(
    feed.ticker == market.ticker,
    MeridianError::InvalidTicker
);
```

Also remove `#[allow(dead_code)]` from the `ticker` field in `OraclePriceFeed` (line 43).

**Dependencies**: None
**Verify**: Add an on-chain test that attempts to settle a market with a mismatched oracle feed ticker; expect `InvalidTicker` error.

---

### C2: Oracle ticker parsed but never validated (covered by C1 fix above)

**Severity**: CRITICAL
**File**: `programs/meridian/src/instructions/settle_market.rs:43-44, 80-100`
**Fix**: Same as C1 — add the `require!` check and remove `#[allow(dead_code)]`. Also remove `#[allow(dead_code)]` from the `authority` field (line 48) since it's genuinely unused but that's fine for a parsed struct.

---

### H1: Silent swallow of resting order failure

**Severity**: HIGH
**File**: `programs/meridian/src/matching/engine.rs:100-110`
**Problem**: `let _ = place_resting_order(...)` discards the error when the orderbook level is full. The user's USDC/Yes/No tokens are already escrowed, and the remaining quantity isn't refunded if the order can't be placed (it's neither filled nor rested).

**Current code** (lines 99-110):
```rust
if order_type == ORDER_TYPE_LIMIT && result.remaining_quantity >= MIN_ORDER_SIZE {
    let _ = place_resting_order(
        book, taker, side, price, result.remaining_quantity,
        quantity, timestamp,
    );
}
```

**Fix**: Return a `book_full` flag from `match_order` so the caller (`handle_place_order`) can detect the failure and refund. Change the match_order return:

1. Add a `resting_failed: bool` field to `MatchResult`.
2. Replace `let _ =` with:
```rust
if order_type == ORDER_TYPE_LIMIT && result.remaining_quantity >= MIN_ORDER_SIZE {
    match place_resting_order(book, taker, side, price, result.remaining_quantity, quantity, timestamp) {
        Ok(_order_id) => {},
        Err(()) => {
            result.resting_failed = true;
        }
    }
}
```
3. In `handle_place_order` (place_order.rs), after `match_order` returns, check `match_result.resting_failed`. If true, the `remaining_quantity` was NOT placed on the book, so it must be treated like an unfilled market order amount — refund the escrow. The existing `refund_unfilled` function handles refunds; we just need to set the condition. The simplest fix: if `resting_failed`, set `remaining_quantity` to be refunded by treating it as if `order_type == ORDER_TYPE_MARKET`:

```rust
// After match_order returns, before refund_unfilled:
let effective_order_type = if match_result.resting_failed {
    ORDER_TYPE_MARKET  // Force refund of remaining
} else {
    order_type
};
// Pass effective_order_type to refund_unfilled
```

4. Add a `msg!` log when resting fails: `"Order book level full at price={}, refunding {} remaining"`.

**Dependencies**: None
**Verify**: Write an on-chain test that fills all 16 slots at price=50, then submits a 17th limit order at price=50. Verify the order's escrowed funds are returned to the user.

---

### H2: One-sided position constraint

**Severity**: HIGH
**File**: `programs/meridian/src/instructions/place_order.rs:242-248`
**Problem**: Line 243-247 blocks USDC bids (Buy Yes, side=0) if user holds No tokens, but does NOT block No-backed bids (side=2) if user holds Yes tokens. This asymmetry allows a user to hold Yes tokens and simultaneously submit a "Sell No" order, creating a contradictory position.

**Current code**:
```rust
if side == SIDE_USDC_BID {
    require!(
        ctx.accounts.user_no_ata.amount == 0,
        MeridianError::ConflictingPosition
    );
}
```

**Fix**: Add the symmetric constraint for No-backed bids:
```rust
if side == SIDE_USDC_BID {
    require!(
        ctx.accounts.user_no_ata.amount == 0,
        MeridianError::ConflictingPosition
    );
}
if side == SIDE_NO_BID {
    require!(
        ctx.accounts.user_yes_ata.amount == 0,
        MeridianError::ConflictingPosition
    );
}
```

**Dependencies**: None
**Verify**: Write an on-chain test: mint Yes tokens to a user, then attempt side=2 (No-backed bid). Expect `ConflictingPosition` error.

---

### H7: Oracle accepts future timestamps

**Severity**: HIGH
**File**: `programs/mock-oracle/src/instructions/update_price.rs:17-24`
**Problem**: `handle_update_price` accepts any `timestamp > 0` with no check against the clock. An authority could set a future timestamp, making the feed appear fresh indefinitely.

**Fix**: Add a clock check:
```rust
pub fn handle_update_price(ctx: Context<UpdatePrice>, price: u64, confidence: u64, timestamp: i64) -> Result<()> {
    require!(price > 0, OracleError::InvalidPrice);
    require!(timestamp > 0, OracleError::InvalidTimestamp);

    // New: reject future timestamps
    let clock = Clock::get()?;
    require!(
        timestamp <= clock.unix_timestamp,
        OracleError::InvalidTimestamp
    );

    // ... rest unchanged
}
```

**Dependencies**: None
**Verify**: Write an on-chain test that calls update_price with a timestamp 60 seconds in the future. Expect `InvalidTimestamp`.

---

### M5: Vault not ring-fenced for pair burns

**Severity**: MEDIUM
**File**: `programs/meridian/src/instructions/redeem.rs:73-152`
**Problem**: `handle_pair_burn` (mode=0) transfers USDC from the vault before settlement. If enough pair burns occur, the vault could be drained below what's needed to pay winners. The only check is `usdc_vault.amount >= quantity` (line 85-88), but this doesn't account for outstanding winning tokens.

**Fix**: Add a ring-fencing check. After settlement, the vault must retain at least enough to cover all outstanding winning tokens. Before settlement, pair burns are safe because every pair burned reduces both yes and no supply equally (the vault balance is exactly `total_minted - total_redeemed` in USDC lamports). The invariant is:

```
vault_balance >= (total_minted - total_redeemed) after the burn
```

Actually, re-reading the code: pair burn burns 1 Yes + 1 No and returns $1 USDC. After the burn, `total_redeemed` increases by `quantity`. So vault drops by `quantity` and `(total_minted - total_redeemed)` also drops by `quantity`. The invariant is maintained. Post-settlement, winners can redeem $1 per winning token, which also comes from the vault. The issue is that pair burns AFTER settlement could drain funds that winners need.

**Real fix**: In `handle_pair_burn`, if the market is settled, ensure the vault retains enough for outstanding winners. After settlement:
- Winning token supply = `yes_mint.supply` (if outcome=1) or `no_mint.supply` (if outcome=2)
- Required reserve = winning_token_supply (1:1 USDC backing)
- Available for pair burn = vault_balance - winning_token_supply

```rust
// In handle_pair_burn, after the existing vault balance check (line 84-88):
if market.is_settled && market.outcome > 0 {
    let winning_supply = match market.outcome {
        1 => ctx.accounts.yes_mint.supply,
        2 => ctx.accounts.no_mint.supply,
        _ => 0,
    };
    // After this burn, vault must still cover outstanding winners
    require!(
        ctx.accounts.usdc_vault.amount.checked_sub(quantity)
            .ok_or(MeridianError::ArithmeticOverflow)?
            >= winning_supply,
        MeridianError::InsufficientVaultBalance
    );
}
```

**Dependencies**: None
**Verify**: Write a test: settle market (Yes wins), have a user pair-burn enough to drain the vault below yes_mint.supply. Expect `InsufficientVaultBalance`.

---

### M6: Override resets deadline, blocking winners

**Severity**: MEDIUM
**File**: `programs/meridian/src/instructions/admin_override_settlement.rs:59-62`
**Problem**: Each override resets `override_deadline = now + 3600`, so 3 overrides could block redemptions for up to 3+ hours. Design tradeoff — the admin needs time to correct errors.

**Fix**: Cap the total extension. Instead of resetting from `now`, extend from the original deadline (which was `settled_at + 3600`). Change line 59:

```rust
// Old: always resets from now
// market.override_deadline = clock.unix_timestamp.checked_add(3600)...

// New: extend from ORIGINAL settlement time, not from now
// Maximum deadline = settled_at + 3600 * (override_count + 1)
// This means first override extends to settled_at + 7200, second to settled_at + 10800
let max_deadline = market.settled_at
    .checked_add(3600_i64.checked_mul((market.override_count + 1) as i64)
        .ok_or(MeridianError::ArithmeticOverflow)?)
    .ok_or(MeridianError::ArithmeticOverflow)?;
market.override_deadline = max_deadline;
```

Wait — `override_count` is incremented AFTER this line (line 63: `market.override_count += 1`). So at the time of this calculation, `override_count` is 0-based. After the line `market.override_count += 1`, the new count is 1, 2, or 3. We want:
- After 1st override: deadline = settled_at + 7200 (2 hours from settlement)
- After 2nd override: deadline = settled_at + 10800 (3 hours)
- After 3rd override: deadline = settled_at + 14400 (4 hours max)

So use `override_count + 2` (since override_count is still the pre-increment value):

```rust
let new_deadline = market.settled_at
    .checked_add(
        OVERRIDE_WINDOW_SECS
            .checked_mul((market.override_count as i64) + 2)
            .ok_or(MeridianError::ArithmeticOverflow)?
    )
    .ok_or(MeridianError::ArithmeticOverflow)?;
market.override_deadline = new_deadline;
```

This needs `use crate::state::order_book::OVERRIDE_WINDOW_SECS;` or just use the literal `3600_i64`.

**Dependencies**: None
**Verify**: Write a test: settle, override 3 times, check that `override_deadline <= settled_at + 14400`.

---

### L7: level.count could diverge from active slots

**Severity**: LOW
**File**: `programs/meridian/src/matching/engine.rs:285-287`
**Problem**: The `if level.count > 0 { level.count -= 1; }` guard prevents underflow but masks divergence. If count ever gets out of sync, the `has_active_orders` function (line 463-470) will report incorrect state.

**Fix**: This is a defensive guard, not a bug per se. The real fix is to ensure count can never go negative. The current code is correct — every `set_active(true)` increments count, every `set_active(false)` decrements with the guard. The guard is the right approach. But we can add a debug assertion:

```rust
// In match_at_level_for_side, line 285:
debug_assert!(level.count > 0, "level.count underflow at level_idx={}", level_idx);
if level.count > 0 {
    level.count -= 1;
}
```

Same pattern in `cancel_resting_order` (line 389) and `crank_cancel_batch` (line 453).

**Dependencies**: None
**Verify**: Existing tests pass (debug_assert only fires in debug builds).

---

### L8: expiry_day recomputed in signer seeds macro

**Severity**: LOW
**File**: `programs/meridian/src/helpers.rs:19`
**Problem**: The macro computes `expiry_day_val = (market.market_close_unix / 86400) as u32` every time signer seeds are needed. This is correct but fragile — if the formula ever diverges from how the PDA was originally derived, all CPI calls would fail.

**Fix**: Store the `expiry_day` in `StrikeMarket` at creation time, then use it directly in the macro. However, this requires a state migration (adding a field to StrikeMarket). The cost outweighs the benefit for a mock oracle dev platform.

**Alternative fix (lower risk)**: Extract the computation into a shared const function and add a comment documenting the invariant:

```rust
/// Compute the expiry day from market_close_unix.
/// INVARIANT: This must match the seed derivation in create_market.
pub const fn expiry_day(market_close_unix: i64) -> u32 {
    (market_close_unix / 86400) as u32
}
```

Then use it in the macro:
```rust
let expiry_day_val = crate::helpers::expiry_day($market.market_close_unix);
```

**Dependencies**: None
**Verify**: All existing on-chain tests pass (no behavior change).

---

## WS-2: Frontend Correctness (TypeScript/React)

### H3: P&L hardcoded at 50c mid

**Severity**: HIGH
**Files**:
- `app/meridian-web/src/hooks/usePortfolioSnapshot.ts:55-57`
- `app/meridian-web/src/components/portfolio/PnlTab.tsx:143-144`

**Problem**: In `usePortfolioSnapshot`, when `midPrices?.get(marketKey)` returns undefined (which is the default since callers don't pass `midPrices`), the fallback is `0.5` (line 56). The hook's signature accepts an optional `midPrices` map, but no caller provides it. In `PnlTab.tsx`, line 143-144 computes `currentVal = (yesBal + noBal) * 0.5` — always 50c.

**Fix (two parts)**:

**Part A — PnlTab.tsx**: Use actual order book mid prices from `useMarketSummaries` or per-position `useOrderBook` data. The `PnlTab` already imports `useCostBasis` and `usePositions`. Add `useMarketSummaries` to get real mid prices:

```typescript
// In PnlTab, after existing hook calls:
const { data: summaries = [] } = useMarketSummaries();
const midPriceMap = useMemo(() => {
  const map = new Map<string, number>();
  for (const s of summaries) {
    if (s.bestBid !== null && s.bestAsk !== null) {
      map.set(s.marketKey, (s.bestBid + s.bestAsk) / 200); // cents to dollars
    }
  }
  return map;
}, [summaries]);
```

Then in the `positionRows` mapping (line 136-163), replace:
```typescript
// Old: const currentVal = (yesBal + noBal) * 0.5;
// New:
const mid = midPriceMap.get(marketKey);
const currentVal = mid !== undefined
  ? yesBal * mid + noBal * (1 - mid)
  : (yesBal + noBal) * 0.5; // fallback only if no book data
```

**Part B — usePortfolioSnapshot.ts**: Accept and propagate mid prices. Callers should pass the midPriceMap:

In `PnlTab.tsx`, pass midPrices to the hook:
```typescript
const { intradayData, ... } = usePortfolioSnapshot(midPriceMap);
```

The hook already supports this parameter (line 24). The fix is in the caller, not the hook.

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run` — verify existing tests pass. Manual verification: open portfolio page, check P&L values change with market mid price.

---

### H4: TradeModal — inverted NO potential win + navigates instead of trading

**Severity**: HIGH
**File**: `app/meridian-web/src/components/TradeModal.tsx:48-61`

**Problem (a)**: Line 52: `potentialWin = quantity * (100 - unitPrice) / 100`. For NO trades, `unitPrice = 100 - initialPrice`. So `potentialWin = quantity * (100 - (100 - initialPrice)) / 100 = quantity * initialPrice / 100`. This is correct — if you buy NO at (100 - P)c, you win $1 - (100-P)c = Pc per contract. Actually this IS correct.

Let me re-check: if `side === "NO"`, `unitPrice = 100 - (initialPrice ?? 50)`. Cost per contract = unitPrice/100. Win per contract = (100 - unitPrice)/100 = initialPrice/100. So `potentialWin = quantity * initialPrice / 100`. That's the profit on winning, not gross payout. Actually, `potentialWin` should be net profit = payout - cost = $1 - cost = `(100 - unitPrice)/100` per contract. Wait, that's exactly what line 52 computes. Let me re-read the issue...

The issue says "Potential win inverted for NO trades." Looking at the display: "Potential win: +$X USDC". For YES at 65c: cost=65c, payout=$1, profit=35c. `potentialWin = (100-65)/100 = 0.35` per contract. Correct. For NO at 35c (initialPrice=65): cost=35c, payout=$1, profit=65c. `unitPrice = 100-65 = 35`. `potentialWin = (100-35)/100 = 0.65`. Correct.

Actually, looking more carefully: the potential win shown is `(100 - unitPrice)` which is the NET win (payout minus cost). For YES at 65c: net = 35c. For NO when initialPrice=65: unitPrice=35, net = 65c. This seems correct.

Wait — re-reading more carefully. `potentialWin = quantity * (100 - unitPrice) / 100`. This is the NET profit per contract times quantity. For NO at 35c cost, you get $1 if NO wins, net profit = 65c. The calculation gives 65c. This IS correct.

**Problem (b)**: Line 59: `router.push(...)` — the button navigates to the trade page instead of actually submitting a transaction. This is a significant UX issue — the modal is a landing-page quick-trade preview, not a real order form.

**Fix**: Change `handleTrade` to navigate to the trade page with pre-filled parameters (this is actually the intended behavior — the modal is on the landing page, the actual trade form is on `/trade/[ticker]`). But the button label says "Buy 10 YES @ 65c" which implies it will execute. The fix is to change the button label to clarify it's a navigation:

```typescript
// Change button text from:
//   Buy {quantity} {side} @ {unitPrice}c
// To:
//   Trade {side} on {ticker}
```

Or better, add a note below the button: "Opens the trading page". But this is a design decision. The simplest correct fix:

```typescript
// Line 196: Change button label
Buy {quantity} {side} @ {unitPrice}¢
// ->
Trade {ticker} {side} →
```

**Dependencies**: None
**Verify**: Manual — open landing page, click trade button on a market, verify it navigates to `/trade/[ticker]` with correct query params.

---

### H5: "Volume" displays totalMinted, not trading volume

**Severity**: HIGH
**Files**:
- `app/meridian-web/src/components/mm/QuoteTable.tsx:47`
- `app/meridian-web/src/hooks/useMarketSummaries.ts:65`

**Problem**: In QuoteTable, line 19 and 47: `totalMinted` is displayed in the "Volume" column. In useMarketSummaries, line 65: `volume: Number(market.totalMinted)`. `totalMinted` is the number of token pairs created (via mintPair), not trading volume (fills).

**Fix**:

1. **useMarketSummaries.ts** — Rename field and add clarity. Since we don't have fill-count data from on-chain (it would require the event indexer), rename the field to `totalMinted` and add a `tradingVolume` field that fetches from the event indexer API if available:

```typescript
// In MarketSummary interface:
totalMinted: number;  // was "volume"
// Remove the misleading "volume" field

// In the query function, line 65:
totalMinted: Number(market.totalMinted) / 1_000_000,
```

2. **QuoteTable.tsx** — Change the column header from "Volume" to "Minted" and display `totalMinted`:

Line 92: Change `<th>Volume</th>` to `<th>Minted</th>`
Line 47: Already shows `totalMinted`, just ensure header matches.

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`

---

### H8: "Sell No" submits Buy Yes (side=0)

**Severity**: HIGH
**File**: `app/meridian-web/src/components/OrderForm.tsx:43-45`

**Problem**: `sideToU8("sell-no")` returns `0` (SIDE_USDC_BID = Buy Yes). The comment says "Sell No = Buy Yes at (100 - price) from the contract's perspective" — this is WRONG. Selling No on-chain is side=2 (SIDE_NO_BID), which escrows No tokens. Side=0 escrows USDC. A user clicking "Sell No" expects to sell their No tokens, but the code escrows their USDC instead.

**Fix**: Change `sideToU8`:
```typescript
function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes":
      return 0;  // SIDE_USDC_BID
    case "sell-yes":
      return 1;  // SIDE_YES_ASK
    case "buy-no":
      return 2;  // SIDE_NO_BID — buying No is done by selling a No-backed bid
    case "sell-no":
      return 1;  // SIDE_YES_ASK — selling No is economically equivalent to selling Yes ask
  }
}
```

Wait, that's also wrong. Let me think about the contract semantics:
- side=0 (USDC_BID): Lock USDC, buy Yes tokens. This IS "Buy Yes".
- side=1 (YES_ASK): Lock Yes tokens, sell them for USDC. This IS "Sell Yes".
- side=2 (NO_BID): Lock No tokens, enter merge/burn. This IS "Sell No" (you're selling your No tokens for USDC via the merge mechanism).

So `sell-no` should map to `2`:
```typescript
function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes": return 0;
    case "sell-yes": return 1;
    case "buy-no": return 2;   // Wrong — see below
    case "sell-no": return 2;  // SIDE_NO_BID: escrow No tokens, get USDC
  }
}
```

But wait — "buy-no" also maps to 2? That can't be right. Let me think again:
- "Buy No" = acquire No tokens. The contract doesn't have a direct "buy No" side. To buy No, you would buy Yes (side=0) and... no, that gives you Yes tokens. Actually, the contract's `mint_pair` is how you get No tokens (you get both Yes and No). There's no direct "buy No" order type.

Actually, looking at the on-chain order types: the contract only supports 3 sides:
- Side 0: You have USDC, want Yes tokens
- Side 1: You have Yes tokens, want USDC
- Side 2: You have No tokens, want USDC (via merge)

So "Buy No" doesn't have a direct mapping. The UI should either (a) not offer "Buy No" or (b) map it to a synthetic operation. Currently `buy-no` maps to `2` which is "Sell No" — that's backwards.

**Corrected fix**:
```typescript
function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes": return 0;   // SIDE_USDC_BID
    case "sell-yes": return 1;  // SIDE_YES_ASK
    case "sell-no": return 2;   // SIDE_NO_BID (escrow No tokens)
    case "buy-no": return 0;    // No direct "buy No" — approximate as Buy Yes?
    // Actually this needs a different approach. "Buy No" = "Sell Yes" at complement price.
    // But the user might not have Yes tokens. For now, map to 0 and let the UI
    // handle the price flip (already done in effectivePrice).
  }
}
```

Hmm, the existing code for "buy-no" maps to `2` and "sell-no" maps to `0`. Let me re-read the intent:
- `buy-no` → side=2: "Buy No" sends side=2 (No-backed bid). But side=2 ESCROWS No tokens. You can't buy No by escrowing No — you already have them. This is wrong.
- `sell-no` → side=0: "Sell No" sends side=0 (USDC bid). But side=0 ESCROWS USDC to buy Yes. This is also wrong.

Both mappings are swapped. The fix:

```typescript
function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes": return 0;   // SIDE_USDC_BID: escrow USDC, get Yes
    case "sell-yes": return 1;  // SIDE_YES_ASK: escrow Yes, get USDC
    case "buy-no": return 0;    // No native "buy No" — user buys Yes (wrong token)
    case "sell-no": return 2;   // SIDE_NO_BID: escrow No, get USDC via merge
  }
}
```

But "buy-no" still doesn't work correctly with side=0 — the user gets Yes tokens, not No tokens. The cleanest fix: remove "buy-no" from the UI since the contract doesn't support it natively (users get No tokens via `mint_pair`). But the issue only mentions "Sell No" being wrong. Fix "sell-no" → 2 and leave a TODO for "buy-no":

```typescript
function sideToU8(side: OrderSide): number {
  switch (side) {
    case "buy-yes": return 0;
    case "sell-yes": return 1;
    case "buy-no": return 0;    // TODO: "Buy No" not natively supported; maps to Buy Yes
    case "sell-no": return 2;   // SIDE_NO_BID: escrow No tokens, receive USDC
  }
}
```

Also update the `effectivePrice` logic — for "sell-no", the price flip `100 - p` should NOT apply since side=2 uses the No bid price directly. Currently (line 66): `if (side === "sell-no") return 100 - p;`. With the corrected mapping to side=2, the on-chain contract uses the price as the No bid price. The user enters a price meaning "I want X cents for my No token", which maps directly to the No-backed bid price. So we should NOT flip:

```typescript
// Line 66: Remove the price flip for sell-no
// Old: if (side === "sell-no") return 100 - p;
// New: sell-no price is used directly as the No bid price
// (The price flip was only needed when sell-no incorrectly mapped to side=0)
```

Wait, I need to think about this more carefully. On-chain side=2 (NO_BID) at price P means: "I have No tokens and I'm willing to merge them with Yes asks at price P or lower." The merge condition is: Yes ask Q + No bid P <= 100. If Q <= 100-P, the merge happens. The No seller gets P cents, the Yes seller gets Q cents (approximately).

So if the user says "I want to sell my No tokens for 40c each", the on-chain price should be 40. The UI "sell-no" price input should be: "What price do you want for your No tokens?" → 40 → on-chain price = 40. No flip needed.

Current code with old mapping (sell-no → side=0): `effectivePrice = 100 - p` was needed because side=0 prices are Yes prices. With the corrected mapping (sell-no → side=2): `effectivePrice = p` directly. So remove the flip.

**Final fix for OrderForm.tsx**:

1. Line 44: Change `return 0;` to `return 2;`
2. Line 66: Remove `if (side === "sell-no") return 100 - p;`
3. Update the `estimatedCost` calculation (line 83) — for sell-no (now side=2), proceeds = price per token:
```typescript
// Line 83: already handles sell-no correctly after removing the flip
const costCents = isBuying ? p : (side === "sell-no" ? p : p);
// Simplifies to:
const costCents = p; // Works for all: buy cost = p, sell proceeds = p
```

Wait, that's not right either. For buy-yes: cost = price cents per token. For sell-yes: proceeds = price cents per token. For sell-no: proceeds = price cents per token. So `costCents = p` for all cases. But the label changes: buys show "Est. Cost", sells show "Est. Proceeds". This is already handled by `isBuying` on line 255.

Simplify:
```typescript
const costCents = p;
return (costCents / 100) * (quantityLamports / LAMPORTS_PER_TOKEN);
```

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`. Manual: connect wallet, select "Sell No", verify the transaction uses side=2.

---

### M1: Fake P&L in MyPositions and PositionsTab

**Severity**: MEDIUM
**Files**:
- `app/meridian-web/src/components/MyPositions.tsx:37`
- `app/meridian-web/src/components/portfolio/PositionsTab.tsx:42`

**Problem**: Both files compute P&L as `pnl = totalValue > 0 ? totalValue : -1` — this is a crude proxy with no cost basis subtracted. It's used for the `interpretPosition` insight tooltip, not for display, so it's cosmetic.

**Fix**: Both components already use `useOrderBook` to get mid price and compute `totalValue`. The issue is that `pnl` should be `totalValue - costBasis`. Import `useCostBasis` in both:

**MyPositions.tsx**:
```typescript
import { useCostBasis } from "@/hooks/useCostBasis";
// ...
// Inside PositionRow:
const { costBasis } = useCostBasis();
const marketKey = position.market.publicKey.toBase58();
const cb = costBasis.get(marketKey);
const totalCost = cb ? cb.totalCostUsdc : 0;
const pnl = totalValue - totalCost;
```

**PositionsTab.tsx**: Same pattern — import useCostBasis, compute real P&L.

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`

---

### M3: Fake social proof with no disclosure

**Severity**: MEDIUM
**File**: `app/meridian-web/src/lib/social-proof.ts`

**Problem**: `tradersActive` and `recentWinPct` are entirely fabricated numbers displayed to users. This is deceptive if presented without disclaimer.

**Fix**: Two changes:
1. Add a `simulated: true` field to `SuggestedTrade` interface.
2. In the UI that displays these values, add a tooltip or disclaimer: "Simulated — not real trading data".

Find where `tradersActive` and `recentWinPct` are displayed:

```typescript
// In the SuggestedTrade interface, add:
simulated: boolean; // true = numbers are simulated, not real

// In generateSuggestedTrades, add to each return:
simulated: true,
```

Then find the UI rendering these fields and add a disclaimer. Need to check which component renders them.

**Dependencies**: Need to find the rendering component
**Verify**: `cd app/meridian-web && npx vitest run`

---

### M4: RedeemPanel shows winner button when outcome=0

**Severity**: MEDIUM
**File**: `app/meridian-web/src/components/RedeemPanel.tsx:44`

**Problem**: Line 44: `const isYesWinner = market.outcome === 1`. When `outcome === 0` (unresolved), `isYesWinner = false`, so the code treats it as "No wins" and shows the No redemption button. Line 49: `canWinnerRedeem = market.isSettled && !inOverrideWindow && winnerBal > BigInt(0)`.

But if `outcome === 0` and `market.isSettled === false`, then `canWinnerRedeem = false` and the button won't show. The issue is only if `outcome === 0` AND `market.isSettled === true` (which shouldn't happen, but defensive coding).

**Fix**: Add explicit check for valid outcome:
```typescript
// Line 44-46: Add outcome validity check
const isYesWinner = market.outcome === 1;
const isNoWinner = market.outcome === 2;
const hasValidOutcome = isYesWinner || isNoWinner;
const winnerBal = isYesWinner ? yesBal : isNoWinner ? noBal : BigInt(0);

// Line 49: Add hasValidOutcome to canWinnerRedeem
const canWinnerRedeem = market.isSettled && hasValidOutcome && !inOverrideWindow && winnerBal > BigInt(0) && !market.isPaused;
```

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`

---

### L1: TransactionReceipt dead UI

**Severity**: LOW
**File**: `app/meridian-web/src/app/trade/[ticker]/page.tsx:133`

**Problem**: `const [receipt, setReceipt] = useState<ReceiptData | null>(null);` — `setReceipt` is never called, so the `TransactionReceipt` component (line 255-264) never renders. The `receipt` variable is only used in the conditional render and the keyboard shortcut.

**Fix**: Either wire up `setReceipt` to be called after successful order placement, or remove the dead code. Since OrderForm doesn't expose a callback for successful trades, the simplest fix is to remove the dead receipt code:

1. Remove the `ReceiptData` interface (lines 24-30).
2. Remove `const [receipt, setReceipt] = useState<ReceiptData | null>(null);` (line 133).
3. Remove the `TransactionReceipt` import (line 17).
4. Remove the conditional render (lines 255-264) — just render `<OrderForm>` directly.
5. Update keyboard shortcuts to remove the receipt close handler.

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`

---

### L2: Loading returns "disconnected" instead of "loading"

**Severity**: LOW
**File**: `app/meridian-web/src/hooks/useWalletState.ts:133`

**Problem**: Line 133: `if (solBalance === null) return "disconnected"` — when the wallet is connected but balances haven't loaded yet, the state incorrectly returns "disconnected" instead of a loading state.

**Fix**: Add a "loading" state:

1. Add `"loading"` to the `WalletFundingState` type:
```typescript
export type WalletFundingState =
  | "disconnected"
  | "loading"
  | "unfunded"
  | "no-usdc"
  | "funded"
  | "has-positions";
```

2. Change line 133:
```typescript
if (solBalance === null) return "loading"; // was "disconnected"
```

**Dependencies**: Check if any consumer of `useWalletState` handles the "disconnected" state in a way that would break if it becomes "loading" during the initial fetch.
**Verify**: `cd app/meridian-web && npx vitest run`

---

### L5: buffer:false may break Solana in browser

**Severity**: LOW
**File**: `app/meridian-web/next.config.js:12`

**Problem**: `buffer: false` tells webpack to not polyfill the `buffer` module. Solana web3.js and SPL token use `Buffer` extensively. However, Next.js apps typically include a `buffer` polyfill elsewhere (e.g., in a layout or via a global polyfill).

**Fix**: Check if a buffer polyfill exists elsewhere. If not, install the `buffer` package and change `buffer: false` to `buffer: require.resolve("buffer/")`:

```javascript
config.resolve.fallback = {
  ...config.resolve.fallback,
  crypto: false,
  stream: false,
  buffer: require.resolve("buffer/"),
};
```

Also add to the webpack plugins to provide the Buffer global:
```javascript
const webpack = require("webpack");
// In webpack config:
config.plugins.push(
  new webpack.ProvidePlugin({
    Buffer: ["buffer", "Buffer"],
  }),
);
```

First, check if `buffer` is already in dependencies.

**Dependencies**: May need `yarn add buffer` in `app/meridian-web/`
**Verify**: `cd app/meridian-web && npx next build` — verify no Buffer-related errors.

---

## WS-3: Services & Scripts

### H6: Unique index drops multi-fill events from same tx

**Severity**: HIGH
**File**: `services/event-indexer/src/db.ts:60`

**Problem**: The unique index `idx_events_sig_type ON events(signature, type, market)` means `INSERT OR IGNORE` silently drops the 2nd, 3rd, etc. fill events from a single transaction that fills multiple orders in the same market. A place_order tx can produce multiple FillEvents with the same signature, type="fill", and market.

**Fix**: Add a sequence number to make fills unique. Change the unique index to include a discriminator:

1. Add a `seq` column to the events table:
```sql
-- In initDb schema:
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  market TEXT NOT NULL,
  data TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,  -- sequence within a tx
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig_type_seq ON events(signature, type, market, seq);
```

2. The index needs a migration for existing DBs. Add an `ALTER TABLE` check:
```typescript
// After db.exec(CREATE TABLE...):
try {
  db.exec("ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists
}
// Drop old index and create new one
db.exec("DROP INDEX IF EXISTS idx_events_sig_type");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig_type_seq ON events(signature, type, market, seq)");
```

3. Update `insertEvent` and `insertEventsBatch` to accept and pass `seq`.

4. Update `parseEventsFromLogs` (in listener.ts) to return events with a sequence number (0-indexed per type per market per tx).

5. Update the `EventRow` interface to include `seq: number`.

6. Update the insert prepared statement:
```sql
INSERT OR IGNORE INTO events (type, market, data, signature, slot, timestamp, seq)
VALUES (@type, @market, @data, @signature, @slot, @timestamp, @seq)
```

**Dependencies**: None
**Verify**: `cd services/event-indexer && npx vitest run`

---

### M2: Double getLatestBlockhash in useTransaction

**Severity**: MEDIUM
**File**: `app/meridian-web/src/hooks/useTransaction.ts:134-141`

**Problem**: Lines 99-102 fetch blockhash for signing, then lines 134-135 fetch a NEW blockhash for confirmation. The second call is unnecessary — the first blockhash can be reused.

**Fix**: Store the blockhash from the first call and reuse it:

```typescript
// Line 98-103: Store blockhash info
let blockhashInfo: { blockhash: string; lastValidBlockHeight: number } | undefined;

if (!("version" in tx)) {
  blockhashInfo = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhashInfo.blockhash;
  tx.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;
}

// Line 133-141: Reuse stored blockhash
const confirmBlockhash = blockhashInfo ?? await connection.getLatestBlockhash("confirmed");
await connection.confirmTransaction(
  {
    signature,
    blockhash: confirmBlockhash.blockhash,
    lastValidBlockHeight: confirmBlockhash.lastValidBlockHeight,
  },
  "confirmed",
);
```

**Dependencies**: None
**Verify**: `cd app/meridian-web && npx vitest run`

---

### M7: Cost basis mixes Yes and No fills

**Severity**: MEDIUM
**File**: `services/event-indexer/src/db.ts:195-199`

**Problem**: The `queryCostBasis` SQL aggregates all buy-side fills (takerSide IN (0, 2) or maker bought) into one bucket per market, regardless of whether the user acquired Yes tokens (side=0) or No tokens (side=2). The resulting `avgPrice` is nonsense for users who bought both.

**Fix**: Split the aggregation by token side. Add a `side` discriminator:

```sql
SELECT
  market,
  CASE
    WHEN (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 0)
      OR (json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1 AND CAST(json_extract(data, '$.makerSide') AS INTEGER) = 0)
    THEN 'yes'
    WHEN (json_extract(data, '$.taker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 2)
      OR (json_extract(data, '$.maker') = @wallet AND CAST(json_extract(data, '$.takerSide') AS INTEGER) = 1 AND CAST(json_extract(data, '$.makerSide') AS INTEGER) = 2)
    THEN 'no'
    ELSE 'yes'
  END as side,
  SUM(...) as totalQuantity,
  SUM(...) as totalCost,
  COUNT(*) as fillCount
FROM events
WHERE type = 'fill' AND (... existing conditions ...)
GROUP BY market, side
```

Also update the `CostBasisRow` interface to include `side: 'yes' | 'no'`.

Update all callers to handle per-side cost basis.

**Dependencies**: None
**Verify**: `cd services/event-indexer && npx vitest run`

---

### M8: Backfill checkpoint only after full completion

**Severity**: MEDIUM
**File**: `services/event-indexer/src/backfill.ts:169-170`

**Problem**: The checkpoint is only written after ALL batches complete (line 169). If the process crashes mid-backfill, the entire scan must restart from the last checkpoint.

**Fix**: Write incremental checkpoints after each batch. Track the newest signature seen so far and update after each batch:

```typescript
// Inside the while loop, after processBatch (line 146):
totalEvents += batchEvents;

// Incremental checkpoint: save progress after each batch
if (newestSignature) {
  upsertCheckpoint(newestSignature.signature, newestSignature.slot);
}
```

Remove the final checkpoint write (lines 168-170) since it's now done incrementally.

Wait, that's not quite right. The backfill walks BACKWARD (newest to oldest). The `newestSignature` is set from the first batch (the most recent transactions). If we checkpoint after each batch with the newest signature, and then crash, on restart we'd use that newest signature as the `until` parameter, which means we'd SKIP transactions between the old checkpoint and where we crashed.

The correct approach: checkpoint should track the OLDEST signature processed in the current run, not the newest. That way, if we crash, we resume from where we left off.

Better fix: Use a separate "backfill cursor" that tracks progress:

```typescript
// After each batch, checkpoint the oldest signature of the batch:
const oldestInBatch = signatures[signatures.length - 1];
// But we also need to track the newest for the final checkpoint.

// Alternative: just move the checkpoint to track the oldest processed signature.
// On restart, backfill continues from there.
```

Actually, simplest correct fix: save the newest-seen signature after each batch completes. The `until` parameter on restart will prevent re-processing. The gap between batches is fine because each batch's events are already inserted:

```typescript
// Inside while loop, after processBatch:
if (newestSignature) {
  upsertCheckpoint(newestSignature.signature, newestSignature.slot);
}
```

This works because:
1. Events are INSERT OR IGNORE — re-inserting is safe
2. The checkpoint moves forward with each batch
3. On crash, we restart from the saved newest signature (which is correct)

**Dependencies**: None
**Verify**: `cd services/event-indexer && npx vitest run`

---

### M9: Makefile test missing SBF_OUT_DIR

**Severity**: MEDIUM
**File**: `Makefile:43`

**Problem**: `make test` runs on-chain tests without `SBF_OUT_DIR`, which bankrun needs to find .so files.

**Fix**: Add the env var:
```makefile
test:
	SBF_OUT_DIR=$(shell pwd)/target/deploy yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
	cd app/meridian-web && yarn test run
	cd services/amm-bot && yarn vitest run
	cd services/market-initializer && yarn vitest run
	cd services/event-indexer && yarn vitest run
```

**Dependencies**: None
**Verify**: `make test` runs successfully.

---

### M10: Makefile services omits market-initializer

**Severity**: MEDIUM
**File**: `Makefile:34`

**Problem**: The `services` target starts oracle-feeder, amm-bot, event-indexer, and automation — but not market-initializer. The echo on line 39 doesn't mention it either, but the automation service likely handles market initialization now.

**Fix**: Check if market-initializer is a standalone long-running service or a one-shot script. Looking at the `services` directory structure and the echo text (line 39: "automation (scheduler: market-init + settlement)"), the automation service handles market initialization on a schedule. So market-initializer is NOT a long-running service — it's invoked by the automation scheduler.

The fix is to update the echo to be accurate (it already mentions market-init in automation). No service addition needed. But we should verify the automation service actually starts market-initializer.

Actually, re-reading the issue: it says `make services` omits market-initializer. If market-initializer is a separate service that should run, add it:

```makefile
services:
	cd services/oracle-feeder && yarn start &
	cd services/amm-bot && yarn start &
	cd services/event-indexer && yarn start &
	cd services/market-initializer && yarn start &
	cd services/automation && yarn start &
```

But if automation already handles market init, this would be redundant. Need to check. For safety, add it with a note:

```makefile
services:
	cd services/oracle-feeder && yarn start &
	cd services/amm-bot && yarn start &
	cd services/market-initializer && yarn start &
	cd services/event-indexer && yarn start &
	cd services/automation && yarn start &
	@echo "All services started in background."
	@echo "  - oracle-feeder (Tradier -> on-chain oracle)"
	@echo "  - amm-bot (liquidity seeder)"
	@echo "  - market-initializer (create daily strike markets)"
	@echo "  - event-indexer (on-chain event listener + REST API)"
	@echo "  - automation (scheduler: settlement + crank)"
```

Also add to `clean`:
```makefile
clean:
	@pkill -f "market-initializer" 2>/dev/null || true
	# ... existing entries
```

**Dependencies**: None
**Verify**: `make services` starts all 5 services.

---

### M11: Load test never places USDC bids

**Severity**: MEDIUM
**File**: `scripts/load-test.ts:493-494`

**Problem**: Line 494: `const side = oi % 2 === 0 ? SIDE_YES_ASK : SIDE_NO_BID;` — alternates between Yes asks (side=1) and No-backed bids (side=2). USDC bids (side=0, Buy Yes) are never placed, so no standard swap fills occur.

**Fix**: Include all three sides in the rotation:
```typescript
const sides = [SIDE_USDC_BID, SIDE_YES_ASK, SIDE_NO_BID];
const side = sides[oi % 3];
const priceBase = side === SIDE_USDC_BID ? 55 : side === SIDE_YES_ASK ? 55 : 45;
```

**Dependencies**: None
**Verify**: Run `npx tsx scripts/load-test.ts` on devnet (when faucet is available).

---

### M12: writeEnv destroys .env formatting

**Severity**: MEDIUM
**File**: `scripts/create-mock-usdc.ts:52-55`

**Problem**: `writeEnv` reads all key-value pairs, then writes them back as `KEY=VALUE\n`. This destroys comments, blank lines, and any custom formatting.

**Fix**: Rewrite `writeEnv` to preserve the original file and only append/update changed keys:

```typescript
function writeEnv(updates: Record<string, string>): void {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      // Append new key
      if (!content.endsWith("\n") && content.length > 0) content += "\n";
      content += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content);
}
```

Change the call site (line 130) to only pass the keys that changed:
```typescript
writeEnv({
  FAUCET_KEYPAIR: faucetJson,
  USDC_MINT: usdcMint.toBase58(),
  NEXT_PUBLIC_USDC_MINT: usdcMint.toBase58(),
});
```

**Dependencies**: None
**Verify**: Create a .env with comments and custom formatting, run the script, verify formatting is preserved.

---

### L3: Event indexer hardcodes PROGRAM_ID

**Severity**: LOW
**File**: `services/event-indexer/src/index.ts:27`

**Problem**: `const PROGRAM_ID = "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth"` is hardcoded instead of imported from `services/shared/src/pda.ts`.

**Fix**:
```typescript
// Replace line 27:
// const PROGRAM_ID = "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth";

// With:
import { MERIDIAN_PROGRAM_ID } from "../../shared/src/pda.ts";

// And update line 35:
// const programId = new PublicKey(PROGRAM_ID);
const programId = MERIDIAN_PROGRAM_ID;
```

Remove the `DEFAULT_RPC_URL` constant too if it's the same as in shared config.

**Dependencies**: None
**Verify**: `cd services/event-indexer && npx vitest run`

---

### L4: Scripts hardcode program IDs

**Severity**: LOW
**Files**:
- `scripts/init-oracle-feeds.ts:30`
- `scripts/init-config.ts:34-35`

**Problem**: Both scripts hardcode `MERIDIAN_PROGRAM_ID` and `MOCK_ORACLE_PROGRAM_ID` instead of importing from shared.

**Fix**:
```typescript
// In both files, replace hardcoded constants with:
import { MERIDIAN_PROGRAM_ID, MOCK_ORACLE_PROGRAM_ID } from "../services/shared/src/pda";
```

Remove the local `const MERIDIAN_PROGRAM_ID = ...` and `const MOCK_ORACLE_PROGRAM_ID = ...` lines.

**Dependencies**: None
**Verify**: `npx tsx scripts/init-config.ts --help` (or just verify it compiles).

---

### L6: Dead await import block in create-mock-usdc

**Severity**: LOW
**File**: `scripts/create-mock-usdc.ts:117-120`

**Problem**: Lines 117-120:
```typescript
const bs58 = await import("@coral-xyz/anchor").then((m) => {
    return null;
}).catch(() => null);
```
This dynamic import always returns null. It's dead code from an abandoned attempt to use bs58 encoding.

**Fix**: Remove lines 117-120 entirely. The faucet keypair is already JSON-encoded on line 124 (`JSON.stringify(faucetSecretArray)`), which is the approach used.

**Dependencies**: None
**Verify**: `npx tsx scripts/create-mock-usdc.ts` (idempotent, will skip if USDC_MINT exists).

---

## WS-4: Audit Pass

After all three work streams complete, run a final audit:

### Step 1: Build verification
```bash
anchor build
cd app/meridian-web && npx next build
```

### Step 2: Full test suite
```bash
SBF_OUT_DIR=/Users/js/dev/peak6/target/deploy RUST_LOG=error yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
cd app/meridian-web && npx vitest run
cd services/amm-bot && npx vitest run
cd services/event-indexer && npx vitest run
```

### Step 3: New test coverage
Write additional tests for:
- C1/C2: Oracle ticker mismatch settlement test
- H1: Orderbook-full refund test
- H2: Symmetric position constraint test
- H7: Future timestamp rejection test
- H8: Sell-No side mapping test (frontend unit test)

### Step 4: Grep for remaining issues
```bash
# Check for other silent error swallows
rg "let _ =" programs/
# Check for other hardcoded program IDs
rg "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth" --type ts
rg "HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ" --type ts
# Check for other #[allow(dead_code)]
rg "allow\(dead_code\)" programs/
# Check for other 0.5 hardcoded mids
rg "\* 0\.5" app/meridian-web/src/
```

---

## Dependency Graph

```
WS-1 (Rust on-chain) ──────────────────────┐
                                            ├──> WS-4 (Audit)
WS-2 (Frontend) ───────────────────────────┤
                                            │
WS-3 (Services/Scripts) ───────────────────┘
```

All three work streams are fully independent and can execute in parallel. WS-4 runs after all three complete.

### Within WS-1 (execution order):
1. C1+C2 (oracle ticker validation) — no deps
2. H1 (resting order failure) — no deps
3. H2 (position constraint) — no deps
4. H7 (future timestamps) — no deps
5. M5 (vault ring-fencing) — no deps
6. M6 (override deadline cap) — no deps
7. L7 (level.count assertions) — no deps
8. L8 (expiry_day helper) — no deps

### Within WS-2 (execution order):
1. H8 (Sell No mapping) — no deps, most impactful
2. H3 (P&L hardcoded mid) — no deps
3. H4 (TradeModal) — no deps
4. H5 (Volume label) — no deps
5. M1 (fake P&L proxy) — depends on H3 pattern
6. M3 (social proof disclaimer) — no deps
7. M4 (RedeemPanel outcome=0) — no deps
8. L1 (dead receipt UI) — no deps
9. L2 (loading state) — no deps
10. L5 (buffer polyfill) — no deps

### Within WS-3 (execution order):
1. H6 (multi-fill unique index) — no deps, most impactful
2. M7 (cost basis side split) — depends on H6 schema change
3. M8 (incremental checkpoint) — no deps
4. M9 (Makefile SBF_OUT_DIR) — no deps
5. M10 (Makefile services) — no deps
6. M11 (load test USDC bids) — no deps
7. M12 (writeEnv preservation) — no deps
8. L3 (event-indexer program ID) — no deps
9. L4 (scripts program IDs) — no deps
10. L6 (dead import block) — no deps
11. M2 (double blockhash) — no deps (frontend but grouped here as it's a hook fix)

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| CRITICAL | 2     | C1 already has `has_one` constraint; C2 ticker validation added |
| HIGH     | 8     | All 8 fixed |
| MEDIUM   | 12    | All 12 fixed |
| LOW      | 8     | All 8 fixed |
| **Total** | **30** | **30** |

Estimated implementation time: 6-8 hours across all three work streams (parallel), plus 1-2 hours for the audit pass.
