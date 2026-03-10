# Meridian Frontend — Full Trading Platform Build Plan

## Overview

9 phases (A–I), ~32 new files, ~4 modified files, ~3,500 net new lines.
All existing components (OrderForm, OrderBook, OraclePrice, SettlementStatus) are production-ready with zero TODOs.

---

## Phase A: Wallet Fixes + Shared Primitives

**No dependencies. Build first. All items parallelizable.**

### A1. Wallet Button Sizing
**File:** `src/components/WalletButton.tsx` (modify ~10 lines)
**File:** `src/app/page.tsx` (modify ~5 lines)

- Remove `compact` from hero section — both "View Markets" and "Connect Wallet" match at `text-sm px-6 py-2.5`
- Keep `compact` only in `layout.tsx` header nav
- Disconnected state: `bg-white/10 hover:bg-white/15 text-white/70 border border-white/10 rounded-lg font-semibold text-sm px-6 py-2.5`

### A2. Wallet Modal CSS Overrides
**File:** `src/app/globals.css` (add ~20 lines)

```css
.wallet-adapter-modal-wrapper { ... }
.wallet-adapter-button { height: 40px; font-size: 14px; border-radius: 8px; }
.wallet-adapter-modal-list .wallet-adapter-button { height: 44px; }
```

Target: `.wallet-adapter-modal` and `.wallet-adapter-button` to match design system (40px height, 14px font, rounded-lg).

### A3. Shared Pricer Library (TDD)
**File:** `src/lib/pricer.ts` (~90 lines) — NEW
**Test:** `src/lib/__tests__/pricer.test.ts` (~80 lines) — NEW, write FIRST

Copied from `services/amm-bot/src/pricer.ts` + `quoter.ts`. Pure math, zero deps.

```typescript
export function normalCdf(x: number): number
export function binaryCallPrice(S: number, K: number, sigma: number, T: number, r?: number): number
export function probToCents(prob: number): number
export function generateQuotes(fairPrice: number, inventory: number, config?: QuoteConfig): QuoteResult
export function shouldHalt(inventory: number, maxInventory: number, consecutiveErrors: number): boolean
export interface QuoteConfig { spreadBps: number; maxInventory: number; skewFactor: number; minEdge: number }
export interface QuoteResult { bidPrice: number; askPrice: number; fairPrice: number; skew: number }
```

**TDD test cases:** ATM binary ≈0.5, deep ITM→1.0, deep OTM→0.0, T=0 edge, σ=0 edge, no NaN/Infinity for extreme inputs, yes+no sum to 1.0, quote spread symmetry.

### A4. Odds Format Utility (TDD)
**File:** `src/lib/odds.ts` (~50 lines) — NEW
**Test:** `src/lib/__tests__/odds.test.ts` (~60 lines) — NEW, write FIRST

```typescript
export type OddsFormat = "cents" | "percentage" | "decimal" | "fractional"
export function formatOdds(cents: number, format: OddsFormat): string
export function centsToPercentage(cents: number): number
export function centsToDecimalOdds(cents: number): number
export function centsToFractionalOdds(cents: number): string
```

Persistent format preference via `localStorage.getItem("oddsFormat")`.

### A5. Event Parsers (TDD)
**File:** `src/lib/eventParsers.ts` (~60 lines) — NEW
**Test:** `src/lib/__tests__/eventParsers.test.ts` (~50 lines) — NEW, write FIRST

```typescript
export interface ParsedFill { maker: string; taker: string; price: number; quantity: number; makerSide: number; takerSide: number; isMerge: boolean; orderId: string; timestamp: number }
export interface ParsedSettlement { market: string; ticker: string; strikePrice: number; settlementPrice: number; outcome: number; timestamp: number }
export function parseFillEvent(event: IndexedEvent): ParsedFill | null
export function parseSettlementEvent(event: IndexedEvent): ParsedSettlement | null
```

Extracts repeated `JSON.parse(event.data)` logic from `SettlementAnalytics.tsx` for reuse everywhere.

### A6. CSV Export Utility (TDD)
**File:** `src/lib/csv.ts` (~40 lines) — NEW
**Test:** `src/lib/__tests__/csv.test.ts` (~50 lines) — NEW, write FIRST

```typescript
export function buildCsv(headers: string[], rows: string[][]): string
export function downloadCsv(data: string, filename: string): void
```

Handles comma escaping, quote escaping, CRLF line endings, blob URL creation + auto-click.

### A7. Share URL Builders (TDD)
**File:** `src/lib/share.ts` (~40 lines) — NEW
**Test:** `src/lib/__tests__/share.test.ts` (~40 lines) — NEW, write FIRST

```typescript
export function buildXShareUrl(ticker: string, side: string, payout: number): string
export function buildLinkedInShareUrl(text: string, url: string): string
export function buildMarketDeepLink(ticker: string, strike?: number): string
```

### A8. Insight Interpretation Functions (TDD)
**File:** `src/lib/insights.ts` (~120 lines) — NEW
**Test:** `src/lib/__tests__/insights.test.ts` (~80 lines) — NEW, write FIRST

```typescript
export interface Insight { text: string; sentiment: "bullish" | "bearish" | "neutral"; urgency: "low" | "medium" | "high" }
export function interpretDelta(delta: number, ticker: string, strike: number): Insight
export function interpretGamma(gamma: number, ticker: string): Insight
export function interpretSpread(spreadCents: number): Insight
export function interpretOrderDepth(bids: DepthLevel[], asks: DepthLevel[]): Insight
export function interpretPosition(side: string, pnl: number, minutesLeft: number): Insight
export function interpretReturnDistribution(currentMove: number, sigma: number): Insight
```

**Phase A totals:** 8 new files + 2 modified, ~570 lines new code, ~360 lines tests.

---

## Phase B: `/trade/[ticker]` Trading Cockpit

**Depends on:** A3 (pricer), A4 (odds), A5 (eventParsers)

### New Hooks

**B-H1. `src/hooks/usePositions.ts` (~120 lines) — NEW**

```typescript
export interface Position { market: ParsedMarket; yesBal: bigint; noBal: bigint; yesAta: PublicKey; noAta: PublicKey }
export function usePositions(): { data: Position[]; isLoading: boolean; isError: boolean; refresh: () => void }
```
- Hooks used: `useConnection`, `useWallet`, `useMarkets`
- Data: calls `connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID })`, matches mints to markets
- Polling: 15s (positions don't change without a tx)
- Error: wallet disconnected → `[]`; RPC error → `isError: true`

**B-H2. `src/hooks/useMyOrders.ts` (~80 lines) — NEW**

```typescript
export interface MyOrder { owner: PublicKey; orderId: bigint; quantity: bigint; side: number; priceLevel: number; timestamp: bigint; marketKey: string }
export function useMyOrders(marketKey: string | null): { orders: MyOrder[]; isLoading: boolean }
```
- Hooks used: `useOrderBook(marketKey)`, `useWallet`
- Filters `raw.orders` where `order.owner.equals(wallet.publicKey)`

**B-H3. `src/hooks/useKeyboardShortcuts.ts` (~50 lines) — NEW**
**Test:** `src/hooks/__tests__/useKeyboardShortcuts.test.ts` — TDD candidate

```typescript
export function useKeyboardShortcuts(handlers: { onYes?: () => void; onNo?: () => void; onConfirm?: () => void; onClose?: () => void; onIncrease?: () => void; onDecrease?: () => void }, enabled?: boolean): void
```
- Ignores keystrokes when `e.target` is `INPUT` or `TEXTAREA`
- Cleans up listeners on unmount

### New Components

**B-C1. `src/app/trade/[ticker]/page.tsx` (~300 lines) — REWRITE**

Layout:
```
[Header: TICKER $price ▲%  |  OraclePrice  |  SettlementStatus]
[Strike selector: $180 | $185 | $190 | $195 | $200]

[Left col (lg:5)]          [Center col (lg:4)]     [Right col (lg:3)]
  OrderBook (yes/no toggle)   OrderForm               MyOrders + cancel
  MarketInfo card             TransactionReceipt      MyPositions
                              RedeemPanel (if settled) FillFeed
```

- Props: `{ params: { ticker: string } }`
- State: `selectedMarketKey`, `receiptData` (post-trade), `oddsFormat`
- Hooks: `useMarkets()`, `useTradierQuotes([ticker])`, `useKeyboardShortcuts`
- Query params: `?side=yes&price=65&qty=10` pre-fills OrderForm (from TradeModal redirect)
- Empty state: "No active markets for {ticker} today"
- Settled state: SettlementStatus prominent + RedeemPanel
- Mobile: single column, collapsible sections via `<details>` or state toggle

**B-C2. `src/components/MarketInfo.tsx` (~80 lines) — NEW**

```typescript
interface MarketInfoProps { market: ParsedMarket; currentPrice?: number }
```
- Displays: strike, close time countdown, total minted, isPaused badge, oracle vs strike distance
- No hooks (pure display, data via props)

**B-C3. `src/components/MyOrders.tsx` (~130 lines) — NEW**
**Test:** `src/components/__tests__/MyOrders.test.tsx` (~100 lines)

```typescript
interface MyOrdersProps { marketKey: string }
```
- Hooks: `useMyOrders(marketKey)`, `useAnchorProgram()`, `useTransaction()`
- Renders table: Side | Price | Qty Remaining | [Cancel]
- Cancel button → `program.methods.cancelOrder(price, orderId).accountsPartial({...}).transaction()`
- Accounts for cancel_order: user, config, market, order_book, escrow_vault, yes_escrow, no_escrow, user_usdc_ata, user_yes_ata, user_no_ata, token_program
- After cancel success: invalidate `["orderbook", marketKey]` query key
- Empty state: "No open orders"
- Disconnected state: "Connect wallet to view orders"

**B-C4. `src/components/MyPositions.tsx` (~100 lines) — NEW**
**Test:** `src/components/__tests__/MyPositions.test.tsx` (~80 lines)

```typescript
interface MyPositionsProps { market: ParsedMarket }
```
- Hooks: `usePositions()` (filtered to this market)
- Displays: Yes balance, No balance, USDC value estimate (from order book mid)
- Quick Flip button: sells entire position at market → pre-filled `placeOrder(side=sell, price=1, type=market)`
- Double Down button: opens OrderForm with same side + current ask

**B-C5. `src/components/RedeemPanel.tsx` (~100 lines) — NEW**
**Test:** `src/components/__tests__/RedeemPanel.test.tsx` (~90 lines)

```typescript
interface RedeemPanelProps { market: ParsedMarket; yesBal: bigint; noBal: bigint; onSuccess?: () => void }
```
- Two modes:
  - **Pair Burn (mode=0):** Available anytime. Burns min(yesBal, noBal) pairs → $1 USDC each. Quantity input.
  - **Winner Redemption (mode=1):** Post-settlement only. Burns winning tokens → $1 each. Disabled during override window (`now < market.overrideDeadline`).
- Instruction: `redeem(mode: u8, quantity: u64)`
- Accounts: user, config, market, yes_mint, no_mint, usdc_vault, user_usdc_ata, user_yes_ata, user_no_ata, token_program
- Shows expected payout before confirming
- Error states: not settled, no balance, paused, override window active

**B-C6. `src/components/TransactionReceipt.tsx` (~80 lines) — NEW**

```typescript
interface TransactionReceiptProps { signature: string; ticker: string; side: string; price: number; quantity: number; cost: number; onClose: () => void }
```
- Rendered after successful trade in the cockpit
- Shows: side, qty, price, total cost, Solana explorer link (`https://explorer.solana.com/tx/{sig}?cluster=devnet`)
- Share buttons: X + LinkedIn (using `src/lib/share.ts`)
- Dismiss button

**B-C7. `src/components/FillFeed.tsx` (~70 lines) — NEW**

```typescript
interface FillFeedProps { marketKey: string; limit?: number }
```
- Hooks: `useFillEvents(marketKey, limit)` (existing)
- Renders scrollable list of recent fills with price, qty, side, timestamp
- Uses `parseFillEvent()` from A5

**B-C8. `src/components/InsightTooltip.tsx` (~40 lines) — NEW**

```typescript
interface InsightTooltipProps { insight: Insight; children: React.ReactNode }
```
- Hover trigger, shows tooltip with insight text
- Border color: green (bullish), red (bearish), amber (neutral)
- Small "?" icon on hover target

**Phase B totals:** 3 new hooks, 8 new components, 1 rewrite. ~1,150 lines code, ~270 lines tests.

---

## Phase C: TradeModal Wiring + Real Data on Cards

**Depends on:** B (cockpit exists to redirect to)

### C1. TradeModal Redirect
**File:** `src/components/TradeModal.tsx` (modify ~15 lines)

Replace `handleTrade` TODO:
```typescript
const handleTrade = useCallback(() => {
  if (!connected) { setWalletVisible(true); return; }
  router.push(`/trade/${ticker}?side=${side.toLowerCase()}&price=${unitPrice}&qty=${quantity}`);
  onClose();
}, [connected, ticker, side, unitPrice, quantity, router, setWalletVisible, onClose]);
```

Add `import { useRouter } from "next/navigation"` and `const router = useRouter()`.

### C2. `useMarketSummaries` Hook
**File:** `src/hooks/useMarketSummaries.ts` (~80 lines) — NEW
**Test:** `src/hooks/__tests__/useMarketSummaries.test.ts` (~60 lines)

```typescript
export interface MarketSummary { marketKey: string; ticker: string; strike: number; bestBid: number | null; bestAsk: number | null; spread: number | null; volume: number; openInterest: number }
export function useMarketSummaries(): { data: MarketSummary[]; isLoading: boolean }
```
- Hooks: `useMarkets()`, `useAnchorProgram()`
- For each active market: fetch order book, compute best bid/ask, total volume from `market.totalMinted`
- Polling: 30s (overview data, not real-time)

### C3. HotTradeCard Real Data
**File:** `src/app/trade/page.tsx` (modify ~40 lines)

- Import `useMarketSummaries()`
- In `generateSuggestedTrades()`: match on-chain markets to Tradier tickers by `ticker + strike`
- When match found: override `impliedProbYes` with real `bestBid`/`bestAsk` midpoint, show real volume
- When no match: keep Tradier-derived implied prob (current behavior)
- Keep fake: activity tape, "traders online", win rate %

### C4. MarketCard Link Fix
**File:** `src/components/MarketCard.tsx` (modify ~3 lines)

Change `href={/trade/${ticker}}` to `href={/trade/${ticker}?market=${/* publicKey from parent */}}`.
Requires adding `marketKey?: string` to `MarketData` interface.

### C5. Max Bet + Presets
**File:** `src/components/TradeModal.tsx` (modify ~30 lines)

- Add `useWalletState()` hook to read USDC balance
- "Max" button: `setQuantity(Math.floor(usdcBalance / unitPrice * 100))`
- Replace `[1, 5, 10, 25, 50, 100]` contract buttons with `[$1, $5, $10, $25, Max]` dollar amounts
- Persist last-used amount to `localStorage.setItem("betPreset")`

### C6. Odds Format Toggle
**File:** `src/app/trade/page.tsx` (modify ~20 lines)

- Add toggle row below header: `[¢] [%] [1.5x] [1/2]`
- State: `oddsFormat` from localStorage
- Pass to HotTradeCard → uses `formatOdds(cents, format)` from A4
- Persists across sessions

**Phase C totals:** 1 new hook, 4 modified files. ~170 lines new, ~60 lines tests.

---

## Phase D: Portfolio

**Depends on:** B-H1 (usePositions), A5 (eventParsers), A6 (csv)

### D1. Portfolio Page Rewrite
**File:** `src/app/portfolio/page.tsx` (~150 lines) — REWRITE

- State: `tab: "positions" | "orders" | "history"`
- Three tabs (upgraded from two)
- Wallet summary bar: SOL + USDC balances from `useWalletState()`
- Disconnected: "Connect wallet" prompt

### D2. Positions Tab
**File:** `src/components/portfolio/PositionsTab.tsx` (~130 lines) — NEW

- Hooks: `usePositions()`, `useMarkets()`
- Table: Ticker | Strike | Yes Qty | No Qty | Market Value | Settlement Countdown | Actions
- Market value: `(yesBal * bestBid) / 1e6` USDC (from order book if available, else "--")
- Settlement countdown per position (E3 from original plan)
- Actions: "Trade More" → `/trade/{ticker}`, "Redeem" (if settled) → RedeemButton
- Streak counter: count settlements where user held winning side (from event indexer fills)
- Win streak badge: "3-win streak" if applicable

### D3. Open Orders Tab
**File:** `src/components/portfolio/OpenOrdersTab.tsx` (~120 lines) — NEW

- For each non-settled market: uses `useMyOrders(market.publicKey)`
- Flat table: Market | Side | Price | Qty | Placed At | [Cancel]
- Cancel → `cancel_order` instruction (same as MyOrders in cockpit)
- Performance: only fetches order books for non-settled markets (~36 max)

### D4. Trade History Tab
**File:** `src/components/portfolio/TradeHistoryTab.tsx` (~100 lines) — NEW

- Hooks: `useIndexedEvents({ type: "fill", limit: 500 })`
- Client-side filter: `parseFillEvent(event)` → match `maker` or `taker` to `wallet.publicKey`
- **Key constraint:** Event indexer has NO wallet filtering — must fetch all fills and filter client-side
- Table: Date | Ticker | Side | Price | Qty | Role (Maker/Taker) | Tx Link
- CSV export button → `downloadCsv()` from A6

### D5. Redeem Button
**File:** `src/components/portfolio/RedeemButton.tsx` (~80 lines) — NEW

- Same logic as RedeemPanel (B-C5) but as a compact button for the positions table
- Shows modal/popover with quantity input and expected payout

**Phase D totals:** 1 rewrite, 4 new components. ~580 lines.

---

## Phase E: Market Maker + Admin Dashboard

**Depends on:** A3 (pricer), B-H1 (usePositions)

### Tab 1: Market Maker

**E1. Page Rewrite**
**File:** `src/app/market-maker/page.tsx` (~200 lines) — REWRITE

- State: `activeTab: "mm" | "admin"`, `selectedTicker`, `config: QuoteConfig`
- Two-tab layout: Market Maker | Admin
- Admin guard: compare `wallet.publicKey` to `config.admin` (from `useAnchorProgram().program.account.globalConfig.fetch()`)
- Non-admin: read-only MM view, admin tab hidden

**E2. Quote Config Panel**
**File:** `src/components/mm/QuoteConfigPanel.tsx` (~110 lines) — NEW

```typescript
interface QuoteConfigPanelProps { config: QuoteConfig; onChange: (c: QuoteConfig) => void; disabled?: boolean }
```
- Sliders/inputs: spreadBps (100–2000), maxInventory (100–5000), skewFactor (0–1), minEdge (1–10)
- Live preview: "Bid: 47c | Ask: 53c | Edge: 3c" computed from `generateQuotes()`

**E3. Live Quote Display**
**File:** `src/components/mm/LiveQuoteDisplay.tsx` (~90 lines) — NEW

```typescript
interface LiveQuoteDisplayProps { market: ParsedMarket; fairPrice: number; inventory: number; config: QuoteConfig }
```
- Hooks: `useOrderBook(market.publicKey)`
- Computes `generateQuotes(fairPrice, inventory, config)` client-side
- Shows: fair value bar, bid/ask with spread, current spread vs target
- `shouldHalt` indicator: red warning if inventory limit hit

**E4. Per-Market Quote Table**
**File:** `src/components/mm/QuoteTable.tsx` (~120 lines) — NEW

- Renders one row per active market
- Columns: Ticker | Strike | Fair Value | Bid | Ask | Spread (bps) | Inventory (gauge) | Status
- Inventory gauge: visual bar from -max to +max, colored green/red
- Circuit breaker badge: "HALTED" if `shouldHalt()` returns true
- Paused badge: if `market.isPaused`

**E5. Aggregate Stats**
**File:** `src/components/mm/AggregateStats.tsx` (~70 lines) — NEW

- Props: computed from market data
- Cards: Net Exposure, Markets Quoting, Markets Halted, USDC Balance, Total Volume

**E6. Bot Health Hook**
**File:** `src/hooks/useBotHealth.ts` (~50 lines) — NEW

```typescript
export function useBotHealth(): { healthy: boolean; lastQuoteAt?: number; errorCount?: number; isLoading: boolean }
```
- Polls `NEXT_PUBLIC_AMM_BOT_URL/health` every 10s
- Fallback: if env not set, infer from order book (check if bot-owned orders exist)

**E7. Bot Health Endpoint**
**File:** `services/amm-bot/src/index.ts` (modify ~30 lines)

Add Express-less HTTP server on port 3003:
```typescript
// GET /health → { running: true, lastQuoteAt, marketsQuoting, errorCount, config }
```

**E8. Panic Button**
In `market-maker/page.tsx`: "Cancel All Orders" button. For each active market, calls `cancelBotOrders()` logic (iterate price levels, find bot's orders, cancel each). Uses admin wallet.

### Tab 2: Admin

**E9. Create Market Form**
**File:** `src/components/admin/CreateMarketForm.tsx` (~120 lines) — NEW

- Fields: Ticker (dropdown MAG7), Strike Price ($), Close Time (date+time picker), Previous Close ($)
- Validation: ticker in MAG7 list, strike > 0, close time in future, previous close > 0
- Instruction: `create_strike_market(ticker, strike_price, expiry_day, market_close_unix, previous_close)`
- Accounts: admin, config, market, yes_mint, no_mint, usdc_vault, escrow_vault, yes_escrow, no_escrow, order_book, oracle_feed, usdc_mint, token_program, system_program, rent
- Post-success: show market pubkey, suggest setting ALT

**E10. Market Actions**
**File:** `src/components/admin/MarketActions.tsx` (~100 lines) — NEW

- Per-market action row in a table
- Settle button (only if !settled && past close time): `settle_market()` — permissionless, 4 accounts
- Pause/Unpause toggle: `pause(market)` / `unpause(market)` — 3 accounts
- Admin Settle (only if !settled && 1hr past close): `admin_settle(price)` — 3 accounts, price input
- Override (only if settled && within override window): `admin_override_settlement(price)` — 3 accounts, shows override count/max 3

**E11. Global Pause Toggle**
In admin tab: single toggle calling `pause(null)` / `unpause(null)` for global pause.

**Phase E totals:** 1 rewrite, 7 new components, 2 new hooks, 1 service modification. ~1,060 lines.

---

## Phase F: Gamification & Social

**Depends on:** B (cockpit exists), D (portfolio exists)

### F1. Confetti on Wins
**File:** `src/hooks/useSettlementWatcher.ts` (~60 lines) — NEW

- Hooks: `useMarkets()`, `usePositions()`, `useWallet()`
- Watches for `isSettled` transitions (tracks previous state in ref)
- When market transitions to settled AND user holds winning tokens: fire confetti + toast "You won $X!"
- Package: `canvas-confetti` (~6KB)
- Install: `yarn add canvas-confetti && yarn add -D @types/canvas-confetti`

### F2. Sound Effects
**File:** `src/hooks/useSoundEffects.ts` (~40 lines) — NEW

- localStorage toggle: `soundEffects: "on" | "off"` (default off)
- `playFill()`: short ka-ching on order fill
- `playSettle()`: bell on settlement
- Uses `new Audio("/sounds/fill.mp3")` with tiny mp3 files in `public/sounds/`

### F3. Live Fill Ticker
**File:** `src/components/LiveFillTicker.tsx` (~70 lines) — NEW

```typescript
// No props — goes in layout.tsx header or footer
```
- Hooks: `useIndexedEvents({ type: "fill", limit: 20 })`
- Scrolling marquee of real on-chain fills: "5 YES AAPL@195 filled at 63c — 12s ago"
- Uses `parseFillEvent()` from A5
- Falls back to fake activity tape if indexer offline

### F4. Share Buttons
**File:** `src/components/ShareButtons.tsx` (~50 lines) — NEW

```typescript
interface ShareButtonsProps { ticker: string; side: string; payout?: number; marketUrl: string }
```
- Share to X: `buildXShareUrl()` from A7
- Share to LinkedIn: `buildLinkedInShareUrl()` from A7
- Renders as icon buttons (X logo, LinkedIn logo)
- Used in: TransactionReceipt (B-C6), settlement win toast, portfolio win rows

**Phase F totals:** 2 new hooks, 2 new components, 1 package install. ~220 lines.

---

## Phase G: Mobile Responsiveness

**Depends on:** B, C, D, E all built

CSS/layout changes only. No new components or logic.

### G1. Trade Cockpit Mobile
- Three-column → single column on `< lg`
- OrderBook and MyOrders collapse into `<details>` accordions
- OrderForm always visible (it's the action)
- Strike selector: horizontal scroll on overflow

### G2. Trade Cards Page
- Grid: `grid-cols-1` on mobile (already there), verify card content doesn't overflow
- Sticky urgency banner at top of scroll
- Quick Bets strip: 2-col on mobile (already `grid-cols-2`)

### G3. Analytics
- Chart sections stack vertically
- Options chain table: horizontal scroll wrapper (`overflow-x-auto`)
- Ticker selector: horizontal scroll on small screens

### G4. Market Maker / Admin
- Stats cards: 2-col on mobile
- Quote table: horizontal scroll
- Config panel: full-width stacked inputs

### G5. Portfolio
- Position rows → cards on mobile (`< sm`)
- History table → card layout with stacked fields

**Phase G totals:** ~150 lines of CSS/layout changes across 5 files.

---

## Phase H: Contextual Intelligence (Chart Callouts + Tooltips)

**Depends on:** A8 (insights.ts), B-C8 (InsightTooltip)

### H1. Chart Callout Component
**File:** `src/components/ChartCallout.tsx` (~50 lines) — NEW

- For Recharts: renders as `<ReferenceLine>` label or custom `<Label>` component
- Semi-transparent bg, small text, positioned via x/y props

### H2. Wire Insights into Greeks Display
**File:** `src/components/analytics/GreeksDisplay.tsx` (modify ~30 lines)

- Wrap each Greek value with `<InsightTooltip insight={interpretDelta(delta, ticker, strike)}>` etc.
- Dynamic text: "AAPL delta 0.85 → 85% chance of closing above $195"

### H3. Wire Insights into Order Book
**File:** `src/components/OrderBook.tsx` (modify ~15 lines)

- Add spread insight below spread display: `interpretSpread(spread)`
- Add depth insight: `interpretOrderDepth(bids, asks)`

### H4. Wire Insights into Trade Cards
**File:** `src/app/trade/page.tsx` (modify ~20 lines)

- Below each HotTradeCard question: contextual nudge
- "Contrarian play? NO is 28c — 3.5x return if you're right"
- "Coin flip — right at the strike. This is where fortunes are made."

### H5. Wire Insights into Portfolio
**File:** `src/components/portfolio/PositionsTab.tsx` (modify ~15 lines)

- Per-position insight: `interpretPosition(side, pnl, minutesLeft)`
- "Settlement in 22min, you're winning — hold or lock in?"

### H6. Wire Insights into Return Distribution
**File:** `src/components/analytics/HistoricalOverlay.tsx` (modify ~15 lines)

- Annotation at ±1σ: "68% of days"
- If current day's move >1σ: "Today is unusual — top 16%"

**Phase H totals:** 1 new component, 5 modified files. ~145 lines.

---

## Phase I: Final Integration + Polish

**Depends on:** All above phases

### I1. Settle Button on Cockpit
**File:** `src/components/SettleButton.tsx` (~60 lines) — NEW

```typescript
interface SettleButtonProps { market: ParsedMarket; onSuccess?: () => void }
```
- Visible only when `!market.isSettled && now > market.marketCloseUnix`
- Instruction: `settle_market()` — 4 accounts: caller, config, market, oracle_feed
- Permissionless — anyone can trigger

### I2. Mint Pair Button
**File:** `src/components/MintPairButton.tsx` (~90 lines) — NEW

```typescript
interface MintPairButtonProps { market: ParsedMarket; maxQuantity?: number }
```
- Instruction: `mint_pair(quantity: u64)`
- 12 accounts: user, config, market, yes_mint, no_mint, user_usdc_ata, user_yes_ata, user_no_ata, usdc_vault, token_program, associated_token_program, system_program
- ATA auto-creation handled by program (init_if_needed)
- Shows cost: "Lock X USDC → mint X YES + X NO"

### I3. Admin Nav Link
**File:** `src/app/layout.tsx` (modify ~10 lines)

- Conditionally show "Admin" nav link if wallet matches config admin

### I4. Delete History Page
**File:** `src/app/history/page.tsx` — DELETE (merged into portfolio)

History is now a tab in Portfolio (D4). Remove orphaned page.

**Phase I totals:** 2 new components, 2 modified files, 1 deleted file. ~160 lines.

---

## Test Strategy Summary

### Shared Test Utilities (create first)
```
src/test/mocks/anchorProgram.ts   — Fluent Anchor method chain mock factory
src/test/mocks/wallet.ts          — Standard wallet-adapter mock
src/test/mocks/orderbook.ts       — OrderBookData factory
src/test/mocks/market.ts          — ParsedMarket factory with defaults
src/test/mocks/fetch.ts           — setupFetchMock(response) helper
```

### TDD Candidates (write tests BEFORE implementation)
1. `src/lib/__tests__/pricer.test.ts` (A3)
2. `src/lib/__tests__/odds.test.ts` (A4)
3. `src/lib/__tests__/eventParsers.test.ts` (A5)
4. `src/lib/__tests__/csv.test.ts` (A6)
5. `src/lib/__tests__/share.test.ts` (A7)
6. `src/lib/__tests__/insights.test.ts` (A8)
7. `src/hooks/__tests__/useKeyboardShortcuts.test.ts` (B-H3)

### Post-Implementation Tests (write after component works)
8. `src/components/__tests__/MyOrders.test.tsx`
9. `src/components/__tests__/RedeemPanel.test.tsx`
10. `src/components/__tests__/MyPositions.test.tsx`
11. `src/components/__tests__/TransactionReceipt.test.tsx`
12. `src/hooks/__tests__/useMarketSummaries.test.ts`
13. `src/hooks/__tests__/usePositions.test.ts`
14. `src/components/admin/__tests__/CreateMarketForm.test.tsx`
15. `src/components/admin/__tests__/MarketActions.test.tsx`
16. `src/components/mm/__tests__/QuoteTable.test.tsx`
17. `src/hooks/__tests__/useBotHealth.test.ts`

### Total New Test Files: ~22

---

## Dependency Graph & Parallelization

```
PARALLEL GROUP 1 (zero deps — launch simultaneously):
  ├── A1 (wallet sizing)
  ├── A2 (wallet modal CSS)
  ├── A3 (pricer.ts) + test [TDD]
  ├── A4 (odds.ts) + test [TDD]
  ├── A5 (eventParsers.ts) + test [TDD]
  ├── A6 (csv.ts) + test [TDD]
  ├── A7 (share.ts) + test [TDD]
  └── A8 (insights.ts) + test [TDD]

PARALLEL GROUP 2 (after Group 1):
  ├── B-H1 (usePositions hook)
  ├── B-H2 (useMyOrders hook)
  ├── B-H3 (useKeyboardShortcuts) + test [TDD]
  ├── B-C2 (MarketInfo)
  ├── B-C7 (FillFeed)
  └── B-C8 (InsightTooltip)

SEQUENTIAL (after Group 2):
  B-C1 (trade/[ticker] page) — wires all Group 2 components
  ├── then B-C3 (MyOrders) + test
  ├── then B-C4 (MyPositions) + test
  ├── then B-C5 (RedeemPanel) + test
  └── then B-C6 (TransactionReceipt)

PARALLEL GROUP 3 (after B-C1 exists):
  ├── C1 (TradeModal wiring)
  ├── C2 (useMarketSummaries) + test
  ├── C3 (HotTradeCard real data)
  ├── C5 (Max Bet + presets)
  └── C6 (Odds toggle)

PARALLEL GROUP 4 (after B-H1):
  ├── D1-D5 (Portfolio — all components)
  └── E1-E11 (Market Maker + Admin — all components)

PARALLEL GROUP 5 (after Group 3+4):
  ├── F1-F4 (Gamification)
  ├── H1-H6 (Contextual intelligence)
  └── I1-I4 (Integration polish)

FINAL:
  G1-G5 (Mobile pass — after everything is built)
```

### Agent Dispatch Plan

**Wave 1:** 8 parallel agents for Phase A (all TDD libs)
**Wave 2:** 6 parallel agents for Phase B hooks + simple components
**Wave 3:** 1 sequential agent for cockpit page (B-C1) + 4 sub-components
**Wave 4:** 5 parallel agents for Phase C items
**Wave 5:** 2 parallel agents (Portfolio + Market Maker/Admin)
**Wave 6:** 3 parallel agents (Gamification + Intelligence + Integration)
**Wave 7:** 1 agent for mobile pass

---

## Complete File Manifest

### New Files (32)
| File | Lines | Phase |
|------|-------|-------|
| `src/lib/pricer.ts` | 90 | A3 |
| `src/lib/odds.ts` | 50 | A4 |
| `src/lib/eventParsers.ts` | 60 | A5 |
| `src/lib/csv.ts` | 40 | A6 |
| `src/lib/share.ts` | 40 | A7 |
| `src/lib/insights.ts` | 120 | A8 |
| `src/hooks/usePositions.ts` | 120 | B |
| `src/hooks/useMyOrders.ts` | 80 | B |
| `src/hooks/useKeyboardShortcuts.ts` | 50 | B |
| `src/hooks/useMarketSummaries.ts` | 80 | C |
| `src/hooks/useBotHealth.ts` | 50 | E |
| `src/hooks/useSettlementWatcher.ts` | 60 | F |
| `src/hooks/useSoundEffects.ts` | 40 | F |
| `src/app/trade/[ticker]/page.tsx` | 300 | B |
| `src/components/MarketInfo.tsx` | 80 | B |
| `src/components/MyOrders.tsx` | 130 | B |
| `src/components/MyPositions.tsx` | 100 | B |
| `src/components/RedeemPanel.tsx` | 100 | B |
| `src/components/TransactionReceipt.tsx` | 80 | B |
| `src/components/FillFeed.tsx` | 70 | B |
| `src/components/InsightTooltip.tsx` | 40 | B |
| `src/components/ChartCallout.tsx` | 50 | H |
| `src/components/SettleButton.tsx` | 60 | I |
| `src/components/MintPairButton.tsx` | 90 | I |
| `src/components/ShareButtons.tsx` | 50 | F |
| `src/components/LiveFillTicker.tsx` | 70 | F |
| `src/components/portfolio/PositionsTab.tsx` | 130 | D |
| `src/components/portfolio/OpenOrdersTab.tsx` | 120 | D |
| `src/components/portfolio/TradeHistoryTab.tsx` | 100 | D |
| `src/components/portfolio/RedeemButton.tsx` | 80 | D |
| `src/components/mm/QuoteConfigPanel.tsx` | 110 | E |
| `src/components/mm/LiveQuoteDisplay.tsx` | 90 | E |
| `src/components/mm/QuoteTable.tsx` | 120 | E |
| `src/components/mm/AggregateStats.tsx` | 70 | E |
| `src/components/admin/CreateMarketForm.tsx` | 120 | E |
| `src/components/admin/MarketActions.tsx` | 100 | E |

### Modified Files (6)
| File | Changes | Phase |
|------|---------|-------|
| `src/components/WalletButton.tsx` | sizing | A1 |
| `src/app/page.tsx` | remove compact | A1 |
| `src/app/globals.css` | wallet modal CSS | A2 |
| `src/components/TradeModal.tsx` | router redirect + max bet | C |
| `src/app/trade/page.tsx` | real data + odds + insights | C/H |
| `src/app/layout.tsx` | admin nav link | I |
| `services/amm-bot/src/index.ts` | health endpoint | E |

### Rewritten Files (3)
| File | Phase |
|------|-------|
| `src/app/trade/[ticker]/page.tsx` | B |
| `src/app/portfolio/page.tsx` | D |
| `src/app/market-maker/page.tsx` | E |

### Deleted Files (1)
| File | Phase |
|------|-------|
| `src/app/history/page.tsx` | I (merged into portfolio) |

### New Test Files (~22)
| File | Phase | TDD? |
|------|-------|------|
| `src/lib/__tests__/pricer.test.ts` | A3 | Yes |
| `src/lib/__tests__/odds.test.ts` | A4 | Yes |
| `src/lib/__tests__/eventParsers.test.ts` | A5 | Yes |
| `src/lib/__tests__/csv.test.ts` | A6 | Yes |
| `src/lib/__tests__/share.test.ts` | A7 | Yes |
| `src/lib/__tests__/insights.test.ts` | A8 | Yes |
| `src/hooks/__tests__/useKeyboardShortcuts.test.ts` | B | Yes |
| `src/components/__tests__/MyOrders.test.tsx` | B | No |
| `src/components/__tests__/MyPositions.test.tsx` | B | No |
| `src/components/__tests__/RedeemPanel.test.tsx` | B | No |
| `src/components/__tests__/TransactionReceipt.test.tsx` | B | No |
| `src/hooks/__tests__/usePositions.test.ts` | B | No |
| `src/hooks/__tests__/useMarketSummaries.test.ts` | C | No |
| `src/components/admin/__tests__/CreateMarketForm.test.tsx` | E | No |
| `src/components/admin/__tests__/MarketActions.test.tsx` | E | No |
| `src/components/mm/__tests__/QuoteTable.test.tsx` | E | No |
| `src/hooks/__tests__/useBotHealth.test.ts` | E | No |
| `src/hooks/__tests__/useSettlementWatcher.test.ts` | F | No |
| `src/components/__tests__/LiveFillTicker.test.tsx` | F | No |
| `src/components/__tests__/InsightTooltip.test.tsx` | H | No |
| `src/test/mocks/anchorProgram.ts` | setup | — |
| `src/test/mocks/wallet.ts` | setup | — |
| `src/test/mocks/market.ts` | setup | — |
| `src/test/mocks/fetch.ts` | setup | — |

### Grand Totals
- **New production files:** 36
- **New test files:** 24
- **Modified files:** 7
- **Net new production code:** ~3,500 lines
- **Net new test code:** ~1,500 lines
- **Total:** ~5,000 lines

---

## Key Implementation Notes

1. **`cancel_order` accounts:** Must derive all 3 user ATAs (USDC, Yes, No) even though only one gets the refund. Program determines which based on order side.

2. **`redeem` modes:** Mode 0 = pair burn (anytime), Mode 1 = winner redemption (post-settlement). Override window blocks Mode 1 only — pair burns always work.

3. **`mint_pair` ATA creation:** Program uses `init_if_needed` via `associated_token_program`. No client-side ATA pre-creation needed.

4. **Event indexer wallet filtering:** The API has no `wallet` parameter. Must fetch all events for a market and filter client-side by matching `maker` or `taker` to wallet pubkey. For portfolio history, fetch type=fill with limit=500.

5. **Market maker bot loop:** Use `useRef<boolean>` for isRunning inside async interval to avoid stale closures. Always cancel existing orders before placing new ones.

6. **TradeModal side encoding:** YES → `sideU8=0` (USDC bid / Buy Yes), NO → `sideU8=2` (No-backed bid / Buy No via mint+sell path).

7. **Order types in modal:** Use `orderType=0` (market) for TradeModal quick trades. Cockpit OrderForm already supports limit orders.
