# Meridian — Order Book Specification

Canonical reference for the order book schema, matching engine, escrow model, and settlement paths. This document is the single source of truth — BUILD_PLAN.md and DEV_LOG.md reference it but do not override it. Any discrepancy should be resolved in favor of this document.

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Account Schema](#account-schema)
3. [Price Model](#price-model)
4. [Three Order Sides](#three-order-sides)
5. [Escrow Model](#escrow-model)
6. [Matching Engine](#matching-engine)
7. [Settlement Paths](#settlement-paths)
8. [Money Flow Traces](#money-flow-traces)
9. [Order Lifecycle](#order-lifecycle)
10. [Cancellation](#cancellation)
11. [Post-Settlement Cleanup](#post-settlement-cleanup)
12. [Frontend Perspectives](#frontend-perspectives)
13. [Compute & Size Budgets](#compute--size-budgets)
14. [Invariants](#invariants)
15. [Error Conditions](#error-conditions)
16. [Cross-Reference Matrix](#cross-reference-matrix)

---

## Design Philosophy

One order book per market. One matching engine. Three order side types. No separate `sell_no` instruction — all four user-facing trade actions (Buy Yes, Sell Yes, Buy No, Sell No) flow through `place_order` with different `side` values.

**Why a single book**: Two separate books (one for Yes, one for No) would double on-chain storage (~252 KB instead of ~126 KB per market), double matching complexity, and require cross-book arbitrage logic. A single book with three side types achieves the same expressiveness with one account, one engine, and zero arbitrage gaps.

**Why three sides instead of two**: A traditional two-sided book (bid/ask) can only represent Buy Yes (USDC bid) and Sell Yes (Yes ask). No holders wanting to sell have no way to post limit orders. The No-backed bid (side=2) solves this — it's a bid backed by No tokens instead of USDC, enabling limit Sell No orders to rest on the same book.

---

## Account Schema

### OrderBook (Sparse, variable size)

> **Note**: The original dense layout (16 fixed slots per level, ~126KB) was replaced in Phase 6 with a sparse layout. Markets now start at 270 bytes and grow on demand.

```
Header (270 bytes):
  [0..8]     discriminator       // Anchor discriminator
  [8..40]    market: Pubkey      // parent StrikeMarket PDA
  [40..48]   next_order_id: u64  // monotonically incrementing counter
  [48..246]  price_map: [u16; 99]// byte offset per price level, 0xFFFF = unallocated
  [246]      level_count: u8     // active levels with orders
  [247]      max_levels: u8      // allocated level count (monotonically increasing)
  [248]      bump: u8            // PDA bump
  [249..270] _reserved
```

PDA seeds: `[b"order_book", market.key().as_ref()]`

One OrderBook per StrikeMarket. Created inline by `create_strike_market` (270 bytes). Grows via `realloc` when new price levels or order slots are needed. Closed during `close_market`.

### Price Map

The `price_map` is a `[u16; 99]` array mapping price (1-99) to byte offsets within the level data region. Values are byte offsets relative to the end of the 270-byte header. `0xFFFF` (`PRICE_UNALLOCATED`) means no level exists at that price.

This replaces the old fixed-index scheme. Levels are no longer at predictable offsets — they're allocated sequentially as needed, and the price map provides O(1) lookup.

### Level Header (8 bytes)

```
price: u8           // price level (1-99)
active_count: u8    // number of active (unfilled/uncancelled) orders
slot_count: u8      // total allocated slots (grows by 1 via realloc)
_padding: [u8; 5]
```

Each level starts with 1 slot. When all slots are full, `expand_level` adds 1 more slot via `realloc`. No fixed cap per level — grows until the account hits Solana's 10MB limit (theoretical ~89K orders per book).

### OrderSlot (112 bytes)

```
owner: Pubkey              // 32 — wallet that placed the order
order_id: u64              // 8  — unique ID from next_order_id
quantity: u64              // 8  — remaining quantity (token lamports, 6 decimals)
original_quantity: u64     // 8  — quantity at placement (for fill tracking)
side: u8                   // 1  — 0=USDC bid, 1=Yes ask, 2=No-backed bid
_side_padding: [u8; 7]     // 7  — alignment
timestamp: i64             // 8  — Clock::get() at placement
is_active: u8              // 1  — 0 = empty/cancelled/filled, 1 = active
_padding: [u8; 7]          // 7  — alignment
rent_depositor: Pubkey     // 32 — wallet that paid SOL rent for this slot
```

The `rent_depositor` field (added in sparse redesign) tracks who paid the SOL rent for each order slot, enabling rent refunds on cancel/close to the correct wallet.

**`side` field values**:
| Value | Name | User Intent | Collateral |
|---|---|---|---|
| 0 | USDC bid | Buy Yes | USDC |
| 1 | Yes ask | Sell Yes | Yes tokens |
| 2 | No-backed bid | Sell No | No tokens |

**Why sparse over dense**: Dense layout allocated ~126KB per market regardless of activity. Most markets have <10 active orders across 3-5 price levels. Sparse layout costs ~270 bytes for an empty market + ~120 bytes per order. A market with 20 orders costs ~2.7KB instead of ~126KB. Market creation rent dropped from ~0.89 SOL to ~0.019 SOL.

### FillEvent (emitted via `emit!`, not stored on-chain)

```
FillEvent {
  market: Pubkey,
  maker: Pubkey,           // resting order owner
  taker: Pubkey,           // incoming order owner
  price: u8,               // execution price (1-99)
  quantity: u64,            // fill quantity in token lamports
  maker_side: u8,          // 0, 1, or 2
  taker_side: u8,          // 0, 1, or 2
  is_merge: bool,          // true if this fill triggered a merge/burn
  maker_order_id: u64,     // resting order's ID
  timestamp: i64,          // fill time
}
```

`is_merge = true` when one side is a No-backed bid (side=2) and the other is a Yes ask (side=1). This flag tells the frontend to display the fill differently (merge/burn vs standard swap).

---

## Price Model

- **Range**: u8, [1, 99] inclusive. Price 50 = $0.50 USDC.
- **Complementary**: Yes price + No price = 100 always. A Yes at price 60 implies No at price 40.
- **Market orders**: Buy Yes market sends price=99 (willing to pay up to $0.99). Sell Yes market sends price=1 (willing to accept as low as $0.01).
- **Fill rule**: Bid crosses ask when `bid_price >= ask_price`. Execution at the **resting order's price** (maker gets their posted price).
- **No-backed bid price mapping**: A user wanting to Sell No at $0.40 posts a No-backed bid at price 60 (= 100 - 40). This bid sits alongside USDC bids at price 60 and competes for Yes asks at ≤ 60.

### Price Inversion Formula

```
no_price = 100 - yes_price
```

A No-backed bid at price X means: "I will sell my No token, accepting $X worth of exposure where my payout is $(1.00 - X/100) per token." The bid price is expressed in Yes-price terms so it occupies the same book as USDC bids.

---

## Three Order Sides

### Side 0: USDC Bid (Buy Yes)

- **User intent**: "I want to buy Yes tokens."
- **Collateral**: USDC, transferred from user's ATA to `escrow_vault` on placement.
- **Amount escrowed**: `price × quantity / 100` (in USDC lamports). Example: price 60, quantity 1_000_000 → escrow 600_000 USDC lamports ($0.60).
- **On fill (matched against Yes ask)**: Standard swap. USDC from escrow → Yes seller. Yes from yes_escrow → buyer. `is_merge = false`.
- **On cancel**: USDC returned from `escrow_vault` to user's ATA.

### Side 1: Yes Ask (Sell Yes)

- **User intent**: "I want to sell Yes tokens."
- **Collateral**: Yes tokens, transferred from user's ATA to `yes_escrow` on placement.
- **Amount escrowed**: `quantity` Yes token lamports (1:1 with order quantity).
- **On fill (matched against USDC bid)**: Standard swap. Yes from yes_escrow → buyer. USDC from escrow_vault → seller. `is_merge = false`.
- **On fill (matched against No-backed bid)**: Merge/burn. Yes from yes_escrow + No from no_escrow → both burned. $1 from vault released. Seller gets execution price. No holder gets (100 - execution price). `is_merge = true`.
- **On cancel**: Yes tokens returned from `yes_escrow` to user's ATA.

### Side 2: No-Backed Bid (Sell No)

- **User intent**: "I want to sell No tokens."
- **Collateral**: No tokens, transferred from user's ATA to `no_escrow` on placement.
- **Amount escrowed**: `quantity` No token lamports (1:1 with order quantity).
- **Posted price**: The user specifies their desired No sell price. The system converts: `bid_price = 100 - no_sell_price`. Example: Sell No at $0.40 → bid at price 60.
- **On fill (matched against Yes ask)**: Merge/burn. No from no_escrow + Yes from yes_escrow → both burned. $1 from vault released. No seller gets `(100 - execution_price) × quantity / 100`. Yes seller gets `execution_price × quantity / 100`. `is_merge = true`.
- **On fill (matched against USDC bid)**: **This never happens.** No-backed bids and USDC bids are both on the bid side — they never cross each other. No-backed bids only match against Yes asks.
- **On cancel**: No tokens returned from `no_escrow` to user's ATA.

### Side Interaction Matrix

| Taker ↓ / Maker → | USDC Bid (0) | Yes Ask (1) | No-Backed Bid (2) |
|---|---|---|---|
| **USDC Bid (0)** | ✗ same side | ✓ standard swap | ✗ same side |
| **Yes Ask (1)** | ✓ standard swap | ✗ same side | ✓ merge/burn |
| **No-Backed Bid (2)** | ✗ same side | ✓ merge/burn | ✗ same side |

**Key insight**: USDC bids and No-backed bids are both "bid-like" (they want to acquire the opposite token's value). They compete with each other for Yes asks but never match each other. The matching engine treats price levels as having a combined bid side (side 0 + side 2) and an ask side (side 1).

---

## Escrow Model

Three separate token accounts per market, all owned by the market PDA:

| Account | PDA Seeds | Token Type | Holds |
|---|---|---|---|
| `escrow_vault` | `[b"escrow", market.key().as_ref()]` | USDC | USDC collateral from side=0 bids |
| `yes_escrow` | `[b"yes_escrow", market.key().as_ref()]` | Yes | Yes tokens from side=1 asks |
| `no_escrow` | `[b"no_escrow", market.key().as_ref()]` | No | No tokens from side=2 No-backed bids |

**Why separate from the main USDC vault**: The main `usdc_vault` (`[b"vault", market.key()]`) holds mint collateral — exactly `$1 × total_minted` USDC. This vault enforces the $1 invariant. Escrow accounts hold order collateral separately so the vault invariant is never confused by trading activity.

### Escrow Flow

```
Placement:  user ATA  →  escrow account  (lock collateral)
Cancel:     escrow account  →  user ATA   (unlock collateral)
Fill:       escrow account  →  counterparty ATA or burn  (settle trade)
```

### Escrow Balance Invariant

At any moment:
```
escrow_vault.balance = sum of (price × quantity / 100) for all active side=0 orders
yes_escrow.balance   = sum of quantity for all active side=1 orders
no_escrow.balance    = sum of quantity for all active side=2 orders
```

Any violation of these equalities indicates a bug in the matching engine or escrow logic.

---

## Matching Engine

Location: `programs/meridian/src/matching/engine.rs`

The matching engine is a set of **pure functions** — they take order book data and return a list of fills. No account deserialization, no CPI calls, no side effects. The `place_order` instruction handler calls the engine, then executes the fills (token transfers, burns, etc.).

### Algorithm: Price-Time Priority

1. Incoming order specifies: `side`, `price`, `quantity`, `order_type` (Market or Limit).
2. Determine the opposing side to scan:
   - Incoming bid (side=0 or side=2) → scan asks (side=1) from lowest price upward.
   - Incoming ask (side=1) → scan bids (side=0 and side=2) from highest price downward.
3. At each price level, check if the incoming order crosses (bid_price >= ask_price).
4. Within a price level, fill against orders in **timestamp order** (oldest first = FIFO).
5. For each match:
   - Fill quantity = min(incoming_remaining, resting_remaining).
   - Determine settlement path based on the two orders' `side` values (see Settlement Paths).
   - Emit `FillEvent`.
   - Decrement both orders' `quantity` by fill amount.
   - If resting order fully filled, mark `is_active = false`, decrement `PriceLevel.count`.
6. Continue until:
   - Incoming order fully filled, OR
   - No more crossing levels, OR
   - `max_fills` reached (compute cap).
7. If incoming order has remaining quantity:
   - **Market order**: Remaining quantity is returned to user (no resting). Emit partial fill event.
   - **Limit order**: Post remainder on the book at the specified price. Escrow the remaining collateral. Increment `next_order_id`.

### Bid Priority When Scanning

When an incoming Yes ask scans bids, it encounters both USDC bids (side=0) and No-backed bids (side=2) at the same price level. These are matched in **timestamp order** regardless of side type — the engine doesn't prefer one bid type over the other. This is fair and prevents gaming.

### max_fills Parameter

- Default: 10.
- Caps the number of fill operations per `place_order` call.
- Bounds compute predictably — each fill involves token transfers (and potentially burns for merge/burn).
- If an order could match more resting orders than `max_fills`, the remainder rests as a limit order (even if the user specified "Market" — partially filled market orders with remaining quantity still rest to avoid losing the user's funds).

---

## Settlement Paths

Every fill follows exactly one of two paths based on the `side` values of the matched orders.

### Path 1: Standard Swap (is_merge = false)

**Trigger**: USDC bid (0) matched against Yes ask (1). Either can be maker or taker.

**Mechanics**:
1. Yes tokens: `yes_escrow` → buyer's Yes ATA (create via `init_if_needed` if missing).
2. USDC: `escrow_vault` → seller's USDC ATA.
3. Amounts:
   - Buyer receives: `fill_quantity` Yes tokens.
   - Seller receives: `execution_price × fill_quantity / 100` USDC lamports.
4. Execution price = resting order's price (maker's price).
5. USDC escrow decrements. Yes escrow decrements. Vault untouched.
6. `total_minted` and `total_redeemed` unchanged.

### Path 2: Merge/Burn (is_merge = true)

**Trigger**: No-backed bid (2) matched against Yes ask (1). Either can be maker or taker.

**Mechanics**:
1. Take Yes tokens from `yes_escrow`. Take No tokens from `no_escrow`.
2. Burn `fill_quantity` Yes tokens. Burn `fill_quantity` No tokens.
3. Release `fill_quantity × 1_000_000` USDC (= $1 per token) from `usdc_vault`.
4. Split the released USDC:
   - Yes seller receives: `execution_price × fill_quantity / 100` USDC lamports.
   - No seller receives: `(100 - execution_price) × fill_quantity / 100` USDC lamports.
5. Execution price = resting order's price (maker's price).
6. Update StrikeMarket: `total_redeemed += fill_quantity`.
7. Yes mint supply decreases by `fill_quantity`. No mint supply decreases by `fill_quantity`. Supplies remain equal.
8. Vault balance decreases by `fill_quantity × 1_000_000`. Matches new `(total_minted - total_redeemed) × 1_000_000`.

**Why the vault releases $1**: When the pair was originally minted, $1 USDC went into the vault for every Yes+No pair. Burning both tokens destroys the claim on that $1, so the vault releases it to the two parties. This is economically identical to the `redeem` instruction (burn pair → $1) but happens inline during matching.

### Invalid Combinations (Never Match)

| Combination | Why |
|---|---|
| USDC bid × USDC bid | Same side — both want to buy Yes |
| USDC bid × No-backed bid | Same side — both are bids |
| Yes ask × Yes ask | Same side — both want to sell Yes |
| No-backed bid × No-backed bid | Same side — both want to sell No |

---

## Money Flow Traces

Complete USDC/token accounting for every trade scenario. All amounts assume 1 token (1_000_000 lamports) for simplicity.

### Trace 1: Buy Yes (Market) — Standard Swap

```
Setup:
  Alice has resting Yes ask at price 55 (side=1). Yes escrowed in yes_escrow.
  Bob submits USDC bid at price 99 (market buy). USDC escrowed in escrow_vault.

Match: Bob's bid (99) >= Alice's ask (55). Execute at 55 (maker's price).

Settlement (standard swap):
  yes_escrow  → Bob's Yes ATA:     1_000_000 Yes tokens
  escrow_vault → Alice's USDC ATA: 550_000 USDC ($0.55)
  Remaining USDC (990_000 - 550_000 = 440_000) returned to Bob

Ledger:
  Bob:   -$0.55 USDC, +1 Yes
  Alice: +$0.55 USDC, -1 Yes
  Vault: unchanged (mint collateral unaffected)
```

### Trace 2: Buy No (Market) — Atomic Mint + Sell Yes

```
Setup:
  Charlie has resting USDC bid at price 60 (side=0, wants to Buy Yes). USDC escrowed.
  Dave wants to Buy No (market).

Dave's transaction (composed client-side, one Solana tx):
  Step 1: mint_pair — Dave deposits $1 USDC → vault. Gets 1 Yes + 1 No.
  Step 2: place_order(side=1, price=1) — Dave posts Yes as market sell (price=1, take any bid).

Match: Charlie's bid (60) >= Dave's ask (1). Execute at 60 (maker's price).

Settlement (standard swap):
  yes_escrow   → Charlie's Yes ATA:  1_000_000 Yes tokens
  escrow_vault → Dave's USDC ATA:    600_000 USDC ($0.60)

Ledger:
  Dave:    -$1.00 (mint) + $0.60 (sell Yes) = -$0.40 net, holds 1 No
  Charlie: -$0.60 USDC, +1 Yes
  Vault:   +$1.00 (from Dave's mint). Net = +$1.00. total_minted += 1.
```

### Trace 3: Sell No (Limit) — No-Backed Bid, Later Matched

```
Setup:
  Eve holds 1 No token. Wants to sell at $0.45.
  Eve submits place_order(side=2, price=55).
    → Price 55 because: 100 - 45 = 55. Her No-backed bid sits at price level 55.
    → No token escrowed in no_escrow.

Later, Frank submits a Yes ask at price 55 (side=1, Sell Yes at $0.55).
    → Yes token escrowed in yes_escrow.

Match: Eve's bid (55) >= Frank's ask (55). Execute at 55 (Eve is maker).

Settlement (merge/burn):
  yes_escrow: burn 1_000_000 Yes tokens
  no_escrow:  burn 1_000_000 No tokens
  usdc_vault: release 1_000_000 USDC ($1.00)
  → Frank (Yes seller) gets: 55 × 1_000_000 / 100 = 550_000 USDC ($0.55)
  → Eve (No seller) gets:   (100-55) × 1_000_000 / 100 = 450_000 USDC ($0.45)

Ledger:
  Eve:   -1 No, +$0.45 USDC
  Frank: -1 Yes, +$0.55 USDC
  Vault: -$1.00. total_redeemed += 1.
  Check: vault = (total_minted - total_redeemed) × $1.00 ✓
  Check: Yes supply decreased by 1, No supply decreased by 1. Still equal. ✓
```

### Trace 4: Cross-Match Two Sellers (Emergent Behavior)

```
Setup:
  Grace holds Yes, wants to sell at $0.55. Posts Yes ask at price 55 (side=1).
  Hank holds No, wants to sell at $0.45. Posts No-backed bid at price 55 (side=2).
    → 100 - 45 = 55. Same price level as Grace's ask.

Neither Grace nor Hank wants to buy anything. In a traditional two-sided book,
they'd each need a separate buyer. Here, they match directly.

The second order placed (whichever is the taker) crosses the resting order.

Match: bid (55) >= ask (55). Execute at 55.

Settlement (merge/burn):
  Same as Trace 3. Both tokens burned, $1 released, split 55/45.

Result:
  Grace: -1 Yes, +$0.55
  Hank:  -1 No,  +$0.45
  Both exited their positions with zero buyer needed.
  This happens automatically through price-time priority. No special logic.
```

### Trace 5: Buy No (Limit) Matched Against Sell No (Limit)

```
Setup:
  Ivy wants to Buy No at $0.40. She mints a pair ($1 → 1 Yes + 1 No),
  then posts place_order(side=1, price=60) — Yes ask at $0.60.
  Ivy holds her No token.

  Jack wants to Sell No at $0.40. Posts place_order(side=2, price=60).
    → 100 - 40 = 60. His No-backed bid sits at price 60.

Match: Jack's bid (60) >= Ivy's ask (60). Execute at 60.

Settlement (merge/burn):
  Burn Ivy's Yes (from yes_escrow) + Jack's No (from no_escrow).
  Vault releases $1.00.
  Ivy (Yes seller/Buy No user) gets: 60 × 1_000_000 / 100 = 600_000 USDC ($0.60)
  Jack (No seller) gets: 40 × 1_000_000 / 100 = 400_000 USDC ($0.40)

Ledger:
  Ivy:  -$1.00 (mint) + $0.60 (sell Yes) = -$0.40 net, holds 1 No. ← Correct Buy No at $0.40
  Jack: -1 No, +$0.40. ← Correct Sell No at $0.40
  Vault: +$1 (mint) -$1 (burn) = net 0 change. ✓
  total_minted += 1, total_redeemed += 1. Net tokens in circulation unchanged.
```

### Trace 6: Partial Fill Across Multiple Levels

```
Setup: Order book state (Yes asks):
  Price 55: Alice selling 500_000 Yes (side=1)
  Price 56: Bob selling 300_000 Yes (side=1)
  Price 58: Carol selling 1_000_000 Yes (side=1)

  Dave submits USDC bid (side=0) for 1_000_000 at price 57 (limit buy).

Fill 1: Dave × Alice at 55. Fill 500_000. Dave remaining: 500_000.
Fill 2: Dave × Bob at 56. Fill 300_000. Dave remaining: 200_000.
Price 58 > Dave's limit (57). Stop matching.
Dave's remaining 200_000 rests as limit bid at price 57.

USDC escrowed:
  Initially: 57 × 1_000_000 / 100 = 570_000
  Fill 1 cost: 55 × 500_000 / 100 = 275_000 → Alice
  Fill 2 cost: 56 × 300_000 / 100 = 168_000 → Bob
  Remaining escrow: 570_000 - 275_000 - 168_000 = 127_000
  Resting order escrow needed: 57 × 200_000 / 100 = 114_000
  Excess returned: 127_000 - 114_000 = 13_000 → Dave
    (Price improvement — Dave bid 57 but filled at 55 and 56)
```

---

## Order Lifecycle

### Placement

```
User calls place_order(side, price, quantity, order_type, max_fills)
  1. Validate: market not settled, not paused, price in [1,99], quantity >= 1_000_000
  2. Validate: user has sufficient balance (USDC, Yes, or No depending on side)
  3. Escrow collateral (transfer from user ATA to appropriate escrow account)
  4. Run matching engine against opposing side
  5. Execute each fill (transfers, burns, events)
  6. If remaining quantity > 0 and order_type == Limit:
     - Find empty slot at the specified price level
     - Write OrderSlot (owner, order_id, quantity, side, timestamp)
     - Increment next_order_id, PriceLevel.count
  7. If remaining quantity > 0 and order_type == Market:
     - Return remaining escrowed collateral to user
     - (Market orders don't rest)
```

### States

```
                ┌─────────┐
                │ PLACED  │
                └────┬────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
    ┌──────────┐ ┌────────┐ ┌────────────┐
    │ FILLED   │ │PARTIAL │ │ CANCELLED  │
    │(inactive)│ │ FILL   │ │ (inactive) │
    └──────────┘ └───┬────┘ └────────────┘
                     │
              ┌──────┼──────┐
              ▼      ▼      ▼
         FILLED  CANCELLED  CRANK_CANCELLED
```

An order is **active** (`is_active = true`) from placement until it is fully filled, cancelled by owner, or crank-cancelled post-settlement. Partial fills reduce `quantity` but the order remains active.

---

## Cancellation

### Manual Cancel (`cancel_order`)

- **Who**: Order owner only.
- **When**: Anytime, including post-settlement.
- **Lookup**: By `(price_level_index, order_id)` tuple.
- **Action**: Set `is_active = false`. Decrement `PriceLevel.count`. Return escrowed collateral:
  - side=0: USDC from `escrow_vault` → user's USDC ATA
  - side=1: Yes from `yes_escrow` → user's Yes ATA
  - side=2: No from `no_escrow` → user's No ATA
- **Amount returned**: Remaining `quantity` worth of collateral (accounting for partial fills).

### Crank Cancel (`crank_cancel`)

- **Who**: Anyone (permissionless).
- **When**: Only after market is settled (`is_settled == true`).
- **Batch size**: Up to 32 order slots per call.
- **Action**: Iterates through order slots, cancels each active one, returns escrow to the order's `owner`. Same escrow return logic as manual cancel (checks `side` field).
- **Not blocked by override window**: Escrow refunds are outcome-independent — returning someone's escrowed USDC/Yes/No doesn't depend on whether Yes or No won.
- **Returns**: Count of orders cancelled. Settlement service calls in a loop until 0.
- **Coexistence**: Manual `cancel_order` still works alongside. A user who acts first gets their escrow back via manual cancel; crank catches everyone else.

---

## Post-Settlement Cleanup

After `settle_market` sets `is_settled = true`:

1. **Override window** (1 hour): Admin can call `admin_override_settlement` to correct outcome. Redemptions blocked. Crank cancel NOT blocked.
2. **Crank phase**: Settlement service calls `crank_cancel` in a loop (32 slots per call) until order book is empty. All resting orders refunded.
3. **Redemption**: Users burn winning tokens for $1 USDC via `redeem`. Losing tokens burn for $0. Pairs burn for $1.
4. **Market closure** (Phase 6, 90+ days): Admin calls `close_market`. Closes OrderBook + all 4 escrow/vault accounts. Remaining vault USDC swept to treasury.

---

## Frontend Perspectives

The order book can be viewed from two perspectives:

### Yes Perspective (default)

- **Left (bids)**: All side=0 (USDC bids) orders. These are users wanting to Buy Yes.
- **Right (asks)**: All side=1 (Yes asks) orders. These are users wanting to Sell Yes.
- **No-backed bids (side=2)**: Displayed as additional bid depth on the left, visually distinguished (e.g., different color/label). They compete with USDC bids for Yes asks.
- **Spread**: Best bid (highest price across side=0 and side=2) vs best ask (lowest side=1 price).

### No Perspective

Shows the book from a No holder's viewpoint:

- **Left (No bids)**: Side=1 Yes asks, inverted. A Yes ask at price X = "willing to accept X for Yes" = "No is worth (100-X)." Displayed as No bids at price (100-X).
- **Right (No asks)**: Side=2 No-backed bids, inverted. A No-backed bid at price X = "willing to sell No at (100-X)." Displayed as No asks at price (100-X).
- **USDC bids (side=0)**: Also appear as No asks (inverted). A USDC bid at price X = "willing to buy Yes at X" = "No is worth (100-X)" = No ask at (100-X).

### Frontend Data Transform

`lib/orderbook.ts` provides:

- `buildNoView(book)`: Separates orders by side, applies price inversions, produces bid/ask depth arrays for the No perspective.
- Depth aggregation: Sum quantities at each price level for display.
- Spread calculation: Best bid/ask prices for current perspective.

**Important**: With the No-backed bid paradigm, the No perspective shows **real liquidity** from actual No holders (side=2 orders), not just synthetic inversions of Yes orders. This is a significant UX improvement over a pure two-sided book.

---

## Compute & Size Budgets

### Compute Units

| Operation | Budget | Notes |
|---|---|---|
| Simple (mint, cancel, redeem) | 200,000 CU (default) | Single token operation |
| Matching (place_order with fills) | 400,000 CU (explicit) | Set via `ComputeBudgetProgram.setComputeUnitLimit` |
| Merge/burn fills | 400,000 CU | Extra token burns add ~5k CU per fill vs standard swap |

`max_fills` (default 10) bounds compute predictably. Each fill is roughly:
- Standard swap: ~15k CU (2 token transfers)
- Merge/burn: ~25k CU (2 token burns + 2 USDC transfers + vault accounting)

At 10 fills: ~150k–250k CU. Well within 400k budget.

### Transaction Size

All transactions use v0 versioned transactions with per-market Address Lookup Tables (ALTs). Account key overhead is ~1 byte each instead of 32 bytes.

Per-market ALT includes: Market PDA, GlobalConfig, OrderBook, Yes Mint, No Mint, USDC Vault, Escrow Vault, Yes Escrow, No Escrow, Oracle PriceFeed, Token Program, Associated Token Program, System Program, Rent Sysvar.

Heaviest transaction: `place_order` with merge/burn fills needs all market accounts + both user ATAs for Yes, No, and USDC. With ALT: well under the 1,232-byte Solana limit.

### Order Book Account Size

```
OrderBook size ≈ 32 (market) + 8 (next_order_id) + 99 × (16 × 73 + 1) + 1 (bump)
             ≈ 32 + 8 + 99 × 1,169 + 1
             ≈ 115,772 + 41
             ≈ ~126 KB
```

Rent: ~0.89 SOL (devnet: free via airdrop. mainnet: reclaimed on `close_market`).

Solana max account size: 10 MB. We're well under at ~126 KB.

---

## Invariants

These must hold at all times. Any violation is a critical bug.

### 1. Vault Balance Invariant

```
usdc_vault.balance = (total_minted - total_redeemed) × 1_000_000
```

Every `mint_pair` adds $1 and increments `total_minted`. Every `redeem` or merge/burn fill removes $1 and increments `total_redeemed`. The vault is a strict function of these two counters.

### 2. Token Supply Equality

```
yes_mint.supply = no_mint.supply
```

Always. `mint_pair` mints one of each. `redeem` burns one of each. Merge/burn burns one of each. No operation ever creates or destroys only one side.

### 3. Escrow Balance Consistency

```
escrow_vault.balance = Σ (price × remaining_quantity / 100)  for all active side=0 orders
yes_escrow.balance   = Σ remaining_quantity                   for all active side=1 orders
no_escrow.balance    = Σ remaining_quantity                   for all active side=2 orders
```

### 4. Order Slot Consistency

```
PriceLevel.count = number of OrderSlots where is_active == true at that level
```

### 5. Payout Conservation (per merge/burn fill)

```
yes_seller_payout + no_seller_payout = fill_quantity × 1_000_000 / 1_000_000 = fill_quantity (in $1 units)
```

The sum of payouts always equals the amount released from the vault. No USDC created or destroyed.

### 6. Total Supply Conservation

```
yes_mint.supply + total_redeemed = total_minted
no_mint.supply  + total_redeemed = total_minted
```

Tokens exist either as minted supply or as redeemed (burned) tokens. The total never exceeds what was minted.

---

## Error Conditions

All order book errors from `error.rs`:

| Code | Name | Trigger |
|---|---|---|
| 6020 | `MarketAlreadySettled` | `place_order` on a settled market |
| 6022 | `MarketPaused` | `place_order` while market or global is paused |
| 6050 | `InsufficientBalance` | User can't cover escrow amount for their order |
| 6051 | `OrderBookFull` | All 16 slots at the target price level are active |
| 6052 | `InvalidPrice` | Price outside [1, 99] range |
| 6053 | `InvalidQuantity` | Quantity < 1_000_000 lamports (minimum 1 token) |
| 6054 | `OrderNotFound` | `cancel_order` with bad (price_level, order_id) |
| 6055 | `OrderNotOwned` | Attempting to cancel someone else's order |
| 6056 | `NoFillsAvailable` | Market order with empty opposite side |
| 6057 | `InvalidOrderType` | Order type not Market (0) or Limit (1) |
| 6058 | `InvalidSide` | Side not 0 (USDC bid), 1 (Yes ask), or 2 (No-backed bid) |
| 6059 | `ConflictingPosition` | `place_order` side=0 when user holds No tokens, or `mint_pair` when user holds Yes tokens |
| 6090 | `CrankNotNeeded` | `crank_cancel` but order book is already empty |

---

## Cross-Reference Matrix

Where each concept is documented across the three canonical documents:

| Concept | ORDER_BOOK.md | BUILD_PLAN.md | DEV_LOG.md |
|---|---|---|---|
| OrderBook account schema | Account Schema § | Account Schemas (line ~118) | — |
| OrderSlot with side:u8 | Account Schema § | Account Schemas (line ~132) | No-Backed Bid entry |
| Three side types | Three Order Sides § | Access Control Matrix, Phase 2A | No-Backed Bid entry |
| Escrow accounts (3 types) | Escrow Model § | PDA Registry, Phase 2A step 3 | — |
| No-backed bid paradigm | Full document | Phase 2A, Instruction Table #4 | No-Backed Bid entry (full rationale) |
| Merge/burn settlement | Settlement Paths §, Money Flows § | Phase 2A step 2 | No-Backed Bid entry (money flow trace) |
| Price-time priority | Matching Engine § | Phase 2A step 2 | — |
| max_fills compute cap | Matching Engine § | Compute Budget, Phase 2A step 4 | — |
| FillEvent schema | Account Schema § | Anchor Events | — |
| Cancel/crank mechanics | Cancellation § | Access Control Matrix, Phase 3A | — |
| Frontend perspectives | Frontend Perspectives § | Phase 2B (OrderBook component) | — |
| Vault invariant | Invariants § | Architectural Decisions (escrow model) | Market Closure entry |
| Cross-matching two sellers | Money Flow Trace 4 | Phase 2A step 2 (bullet 2) | No-Backed Bid entry |
| Account sizing | Compute & Size Budgets § | Order Book Account Sizing | — |
| Error codes | Error Conditions § | Error Codes section | — |
| Why single book (not two) | Design Philosophy § | Locked Decisions (Order book) | No-Backed Bid entry |
| Buy No atomic path | Money Flow Trace 2 | Phase 2A step 6 | — |
| Post-settlement cleanup | Post-Settlement Cleanup § | Phase 3A step 5, Phase 6A | Market Closure entry |

---

## Changelog

| Date | Change | Reason |
|---|---|---|
| 2026-03-09 | Initial version | Canonical order book spec created from BUILD_PLAN + DEV_LOG |
| 2026-03-09 | `is_bid: bool` → `side: u8` | No-backed bid paradigm — three order types on one book |
| 2026-03-09 | Added No Escrow account | Separate collateral for No-backed bids |
| 2026-03-09 | Removed `sell_no` instruction | All sides flow through `place_order` |
| 2026-03-09 | Added merge/burn settlement path | No-backed bid × Yes ask burns pair, releases $1 from vault |
