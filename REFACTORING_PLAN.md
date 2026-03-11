# Meridian Full Sweep Refactoring Plan

**Option D: Zero Known Tech Debt**
Generated: 2026-03-10

---

## Execution Strategy

Six parallel work streams grouped by file-conflict domains. Each stream is independently testable. Streams 1-4 can run simultaneously. Stream 5 depends on Stream 1 completion. Stream 6 is a final pass.

```
 Phase 1 (parallel):  Stream 1 (Rust on-chain)
                      Stream 2 (Frontend hooks + libs)
                      Stream 3 (Services: correctness bugs)
                      Stream 4 (Scripts + test helpers)

 Phase 2 (after S1):  Stream 5 (Frontend components — depends on S2 hooks)

 Phase 3 (final):     Stream 6 (Cleanup pass — engine.rs comments, analytics page)
```

---

## Stream 1: Rust On-Chain Program

**Items**: #10 (place_order.rs god function), #7 (signer seeds duplication), #18 (OraclePriceFeed size assertion), #23 (merge/burn invariant)

**Test command**: `anchor build && SBF_OUT_DIR=/Users/js/dev/peak6/target/deploy RUST_LOG=error yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'`

**Dependencies**: None. Self-contained on-chain changes.

### 1A: Extract signer seed helper macro (#7)

**Files**:
- `programs/meridian/src/lib.rs` or new `programs/meridian/src/helpers.rs` — add `market_signer_seeds!` macro
- `programs/meridian/src/instructions/place_order.rs` — use macro
- `programs/meridian/src/instructions/cancel_order.rs` — use macro
- `programs/meridian/src/instructions/mint_pair.rs` — use macro
- `programs/meridian/src/instructions/redeem.rs` — use macro
- `programs/meridian/src/instructions/crank_cancel.rs` — use macro

**Changes**:
Create a macro in a shared location:
```rust
macro_rules! market_signer_seeds {
    ($market:expr) => {{
        let strike_bytes = $market.strike_price.to_le_bytes();
        let expiry_day = ($market.market_close_unix / 86400) as u32;
        let expiry_bytes = expiry_day.to_le_bytes();
        let bump_slice = &[$market.bump];
        &[
            crate::state::StrikeMarket::SEED_PREFIX,
            $market.ticker.as_ref(),
            strike_bytes.as_ref(),
            expiry_bytes.as_ref(),
            bump_slice,
        ]
    }};
}
```
Each instruction replaces the 6-line seed block with the macro call. Note: the macro must return references with correct lifetimes — may need to define it as a helper function instead if borrow checker complains with the macro approach.

**Verification**: `anchor build` must succeed. All 91 on-chain tests must pass.

### 1B: Decompose place_order.rs (#10)

**Files**:
- `programs/meridian/src/instructions/place_order.rs` — extract phases into private functions

**Changes**:
Split `handle_place_order` (598 lines) into private functions within the same file:
1. `validate_order(side, price, quantity, order_type, clock, market, user_no_ata) -> Result<()>` — lines 102-127
2. `escrow_taker_assets(ctx, side, price, quantity) -> Result<()>` — lines 146-209
3. `process_fills(fills, side, price, remaining_accounts, signer_seeds, token_accounts) -> Result<u64>` — lines 226-471 (returns price_improvement_refund)
4. `refund_unfilled(side, unfilled, signer_seeds, token_accounts) -> Result<()>` — lines 489-553
5. `update_market_stats(market, fills) -> Result<(u64, u64)>` — lines 557-584 (returns total_merged, total_filled)

The top-level function becomes an orchestrator calling these 5 phases. All types stay in the same file — no module boundary changes, no signature changes to the instruction handler.

**Verification**: `anchor build` + full test suite. Zero behavioral change.

### 1C: OraclePriceFeed compile-time size assertion (#18)

**Files**:
- `programs/meridian/src/instructions/settle_market.rs`

**Changes**:
Add a `const_assert` or static assertion after the `OraclePriceFeed` struct:
```rust
const _: () = assert!(
    std::mem::size_of::<OraclePriceFeed>() + 8 + 1 + 6 <= OraclePriceFeed::MIN_DATA_LEN,
    "OraclePriceFeed layout size mismatch"
);
```
Since the struct uses manual byte parsing (not `repr(C)`), add a more explicit comment documenting the byte layout and validate that `MIN_DATA_LEN` matches the sum: `8 (disc) + 8 (ticker) + 8 (price) + 8 (conf) + 8 (ts) + 32 (authority) + 1 (init) + 1 (bump) + 6 (padding) = 80`. The current value is correct — the assertion codifies it.

### 1D: Merge/burn invariant constant (#23)

**Files**:
- `programs/meridian/src/matching/engine.rs`

**Changes**:
The merge/burn matching condition `Q + P <= 100` appears in two places: `match_against_asks_merge` (line 180: `100u8.saturating_sub(no_bid_price)`) and `match_against_bids` (line 289: `100u8.saturating_sub(min_price)`). Extract:
```rust
/// In a merge/burn, total payout is $1.00 (100 cents).
/// For matching: complementary price = MERGE_TOTAL - order price.
const MERGE_TOTAL_CENTS: u8 = 100;
```
Replace both `100u8` references. This is a tiny change but documents the invariant.

- [ ] 1A: Signer seed macro/helper
- [ ] 1B: Decompose place_order.rs into 5 phases
- [ ] 1C: OraclePriceFeed size assertion
- [ ] 1D: Merge/burn invariant constant
- [ ] Verify: `anchor build` succeeds
- [ ] Verify: All on-chain tests pass

---

## Stream 2: Frontend Shared Libraries + Hooks

**Items**: #2 (normalCdf duplication), #3 (pda/volatility/strikes byte-for-byte duplicates), #4 (binaryCallPrice clamp divergence), #9 (strikes.ts rounding divergence), #19 (hardcoded 50c valuation), #20 (useCostBasis client-side 1000 limit)

**Test command**: `cd app/meridian-web && npx vitest run`

**Dependencies**: None for libs. Hook changes are self-contained.

### 2A: Unify normalCdf and binaryCallPrice (#2, #4)

**Files**:
- `app/meridian-web/src/lib/pricer.ts` — canonical frontend pricer
- `app/meridian-web/src/lib/greeks.ts` — remove duplicate normalCdf, import from pricer
- `services/amm-bot/src/pricer.ts` — align clamp to [0, 1] like frontend

**Changes**:

1. **`greeks.ts`**: Remove the local `normalCdf` function. Add `import { normalCdf } from './pricer';` at top. The greeks.ts version clamps at +/-8; pricer.ts clamps at +/-10. The +/-10 clamp is strictly more permissive and more accurate at tails — use that. Verify that `greeks.ts` exports `normalCdf` for any downstream consumers by re-exporting: `export { normalCdf } from './pricer';`.

2. **`services/amm-bot/src/pricer.ts`**: Change `binaryCallPrice` return clamp from `[0.01, 0.99]` to `[0, 1]` to match frontend. The AMM bot's `probToCents` already clamps to `[1, 99]` before sending to on-chain, so the tighter clamp on the probability was defensive but created divergent behavior. **Before changing**: verify that `services/amm-bot/src/quoter.ts` (or wherever `binaryCallPrice` is consumed) does not depend on the 0.01 floor. The `probToCents` function handles the floor.

3. **Grep for all `normalCdf` imports** across the codebase after changes to verify nothing is broken.

### 2B: Eliminate frontend file duplicates (#3)

**Files**:
- `app/meridian-web/src/lib/pda.ts` — DELETE contents, re-export from shared
- `app/meridian-web/src/lib/volatility.ts` — DELETE contents, re-export from shared
- `app/meridian-web/src/lib/strikes.ts` — DELETE contents, re-export from shared

**Changes**:

These three files are byte-for-byte identical to their `services/shared/src/` counterparts. However, the frontend is a Next.js app that may not resolve `../../services/shared/src/` paths cleanly due to tsconfig boundaries.

**Approach**: Replace each file's contents with a barrel re-export:
```ts
// app/meridian-web/src/lib/pda.ts
export {
  MERIDIAN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
  padTicker,
  strikeToBuffer,
  expiryDayBuffer,
  findGlobalConfig,
  findTreasury,
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findPriceFeed,
} from '../../../../services/shared/src/pda';
```

**Risk**: Next.js may not transpile files outside `app/` by default. If imports fail, add `transpilePackages` to `next.config.js` or use a path alias in `tsconfig.json`. Test with `npm run build` or `npx next build` to verify.

**Fallback**: If cross-boundary imports don't work, add a lint comment `// SYNC: services/shared/src/pda.ts` and keep as copies (document the sync requirement). This is less ideal but pragmatic.

### 2C: Unify strikes rounding (#9)

**Files**:
- `services/shared/src/strikes.ts` — add price-aware rounding
- `app/meridian-web/src/lib/strikes.ts` — already handled by 2B (re-export)

**Changes**:

`services/shared/src/strikes.ts` always rounds to $10. `services/market-initializer/src/strikeSelector.ts` uses $5 for stocks < $100, $10 for >= $100. The shared version should adopt the price-aware logic:
```ts
function roundingIncrement(price: number): number {
  return price >= 100 ? 10 : 5;
}

export function generateStrikes(previousClose: number): StrikeSet {
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const increment = roundingIncrement(previousClose);
  // ... rest unchanged
}
```

**Verify**: Check if any code depends on the always-$10 behavior. Grep for `generateStrikes` usage. The frontend `strikes.ts` is currently only a duplicate of `shared/strikes.ts`, not the `strikeSelector.ts` version — after 2B it will re-export shared, so the shared version must be correct.

### 2D: Fix hardcoded 50c valuation (#19)

**Files**:
- `app/meridian-web/src/hooks/usePortfolioSnapshot.ts`

**Changes**:

Lines 57-58 use `* 0.5` as a fallback mid-price. This makes the P&L chart meaningless — all positions appear at 50c regardless of market state.

The proper fix requires orderbook mid-prices per market, but `useOrderBook` only works for a single market. Pragmatic approach:
1. Accept an optional `midPrices: Map<string, number>` parameter (market key -> mid price 0-1).
2. If a mid price is available, use it. Otherwise, fall back to 0.5 but tag the snapshot as `approximate: true`.
3. The calling component (`PnlTab.tsx`) should pass mid prices from whatever markets are loaded.

This is a **partial fix** — full fix requires a portfolio-wide orderbook aggregation endpoint (#20). Mark with `// TODO: Use real mid prices from portfolio-wide orderbook aggregation (#20)`.

### 2E: Document useCostBasis 1000-event limit (#20)

**Files**:
- `app/meridian-web/src/hooks/useCostBasis.ts`

**Changes**:

The hook fetches up to 1000 fill events client-side. For now, this is acceptable for devnet usage. Adding a server-side aggregation endpoint is a larger feature (new API route + event-indexer query).

Pragmatic approach:
1. Add a comment documenting the limitation and the fix path.
2. Add a `isComplete` boolean to the return value: `isComplete: events.length < 1000`.
3. The consuming component can show a warning when `!isComplete`.

Full server-side aggregation is out of scope for this refactoring sweep (it's a feature, not a refactoring).

- [ ] 2A: Unify normalCdf (greeks.ts imports from pricer.ts) + align binaryCallPrice clamp
- [ ] 2B: Replace frontend pda.ts/volatility.ts/strikes.ts with re-exports (or sync markers)
- [ ] 2C: Add price-aware rounding to shared/strikes.ts
- [ ] 2D: Accept mid-price map in usePortfolioSnapshot
- [ ] 2E: Add isComplete flag to useCostBasis
- [ ] Verify: `cd app/meridian-web && npx vitest run`
- [ ] Verify: `cd app/meridian-web && npx next build` (if re-export approach used)

---

## Stream 3: Service Correctness Bugs

**Items**: #14 (missing verify.ts files), #15 (settlement/index.ts top-level side effects), #16 (oracle-feeder hardcoded byte offsets), #17 (oracle-feeder double-connect), #21 (DST-unsafe toLocaleString in initializer)

**Test commands**:
- `cd services/amm-bot && npx vitest run`
- `cd services/event-indexer && npx vitest run`
- Manual smoke test for settlement/oracle-feeder (these are one-shot/daemon services)

**Dependencies**: None.

### 3A: Create verification stubs (#14)

**Files** (NEW):
- `services/market-initializer/src/verify.ts`
- `services/settlement/src/verify.ts`

**Changes**:

The scheduler references `market-initializer/src/verify.ts` and `settlement/src/verify.ts` but neither exists. Every trading day, the scheduler spawns these as child processes, they fail immediately (ENOENT), and the scheduler logs `MORNING VERIFICATION FAILED` / `AFTERNOON VERIFICATION FAILED`. This is a silent correctness bug that fires every single day.

Create minimal verification scripts:

**`services/market-initializer/src/verify.ts`**:
```ts
// Verify that today's markets were created on-chain.
// Spawned by automation/scheduler.ts at 8:30 AM ET.
import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig, MERIDIAN_PROGRAM_ID } from "../../shared/src/pda.js";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };

const log = createLogger("market-verify");

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  // Check that GlobalConfig exists and has tickers
  const [configPda] = findGlobalConfig();
  const acct = await connection.getAccountInfo(configPda);
  if (!acct) {
    log.critical("GlobalConfig not found");
    process.exit(1);
  }

  // Fetch all markets, check if any were created today
  const adminSecret = process.env.ADMIN_KEYPAIR;
  if (!adminSecret) { log.critical("ADMIN_KEYPAIR required"); process.exit(1); }
  const kp = Keypair.fromSecretKey(bs58.decode(adminSecret));
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  const program = new Program(MeridianIDL as any, provider);

  const markets = await program.account.strikeMarket.all();
  const today = Math.floor(Date.now() / 86400000);
  const todayMarkets = markets.filter(m => {
    const closeUnix = (m.account.marketCloseUnix as any).toNumber();
    const closeDay = Math.floor(closeUnix / 86400);
    return closeDay === today;
  });

  if (todayMarkets.length === 0) {
    log.critical("No markets found for today");
    process.exit(1);
  }

  log.info(`Verification passed: ${todayMarkets.length} markets found for today`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
```

**`services/settlement/src/verify.ts`**: Similar structure — checks that all markets whose `marketCloseUnix` is before now are settled.

### 3B: Fix settlement/index.ts top-level side effects (#15)

**Files**:
- `services/settlement/src/index.ts`

**Changes**:

Lines 39-62 execute at module load: they parse env vars, create connections, and call `process.exit(1)` if ADMIN_KEYPAIR is missing. This means importing the module for testing causes side effects.

Move all construction into `main()`:
1. Move lines 36-61 (env parsing, Keypair creation, Connection, Program, TradierClient) inside `main()`.
2. Pass them to `fetchClosingPrices`, `updateOracleFeeds`, `loadUnsettledMarkets` as parameters (or create a `SettlementContext` object).
3. The `if (!ADMIN_KEYPAIR_B58) { process.exit(1) }` becomes a thrown error inside `main()`.

### 3C: Replace oracle-feeder hardcoded byte offsets (#16)

**Files**:
- `services/oracle-feeder/src/index.ts`

**Changes**:

Lines 27-46 define `GLOBAL_CONFIG_DISCRIMINATOR`, `TICKERS_OFFSET`, `TICKER_COUNT_OFFSET` as hardcoded byte offsets. The function `readTickersFromChain` manually parses the account data. If the on-chain struct layout ever changes, this silently reads garbage.

Replace with Anchor IDL-based deserialization (same pattern as `settlement/src/index.ts` lines 163-186):
```ts
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import MeridianIDL from "../../shared/src/idl/meridian.json" with { type: "json" };
import { findGlobalConfig } from "../../shared/src/pda.js";

async function readTickersFromChain(connection: Connection, authority: Keypair): Promise<string[]> {
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(MeridianIDL as any, provider);
  const [configPda] = findGlobalConfig();
  const config = await program.account.globalConfig.fetch(configPda);
  const tickerCount = (config.tickerCount as number) ?? 0;
  const tickerArrays = config.tickers as number[][];
  const tickers: string[] = [];
  for (let i = 0; i < tickerCount; i++) {
    const t = Buffer.from(tickerArrays[i]).toString("utf-8").replace(/\0+$/, "");
    if (t.length > 0) tickers.push(t);
  }
  return tickers;
}
```

Remove: `GLOBAL_CONFIG_DISCRIMINATOR`, `TICKERS_OFFSET`, `TICKER_COUNT_OFFSET`, `TICKER_SIZE`, the local `findGlobalConfig` function. Import `findGlobalConfig` from `../../shared/src/pda.js`.

Also remove the duplicated `padTicker` from `feeder.ts` (item in additional mediums) — import from `../../shared/src/pda.js`.

### 3D: Fix oracle-feeder double-connect race (#17)

**Files**:
- `services/oracle-feeder/src/feeder.ts`

**Changes**:

The `connect()` function (line 165) is async and called from `startFeeder()` (line 231: `await connect()`). On WebSocket close (line 218), it calls `setTimeout(() => connect(), 5_000)`. If the initial `connect()` hasn't completed when a close event fires (unlikely but possible with fast disconnect), two WebSocket connections could be created.

Add a connecting guard:
```ts
let connecting = false;

async function connect(): Promise<void> {
  if (stopped || connecting) return;
  connecting = true;
  try {
    // ... existing connect logic ...
  } finally {
    connecting = false;
  }
}
```

### 3E: Fix DST-unsafe toLocaleString in initializer (#21)

**Files**:
- `services/market-initializer/src/initializer.ts`

**Changes**:

Lines 437-439 use `toLocaleString("en-US", { timeZone: ... })` to compute ET offset. This is fragile across locales. The `automation/timezone.ts` module already has `getETOffsetMinutes()`.

Replace lines 437-439:
```ts
import { getETOffsetMinutes } from "../../automation/src/timezone.js";
// ...
const etOffsetMinutes = getETOffsetMinutes();
```

This is a direct drop-in. Verify that `computeMarketCloseUnix` still returns the correct value by checking against a known date.

- [ ] 3A: Create market-initializer/src/verify.ts and settlement/src/verify.ts
- [ ] 3B: Move settlement/index.ts construction into main()
- [ ] 3C: Replace oracle-feeder hardcoded byte offsets with IDL fetch
- [ ] 3D: Add connect guard to feeder.ts
- [ ] 3E: Import getETOffsetMinutes in initializer.ts
- [ ] 3F: Remove duplicate padTicker from feeder.ts — import from shared/pda
- [ ] Verify: Service tests pass. Manual smoke test entry points.

---

## Stream 4: Scripts + Test Helpers

**Items**: #5 (load-test/create-test-markets duplication), #6 (mint-pair test helpers), #12 (settlement.test.ts god file — partial), additional mediums (test layout constants, test helper PDA duplication)

**Test command**: `SBF_OUT_DIR=/Users/js/dev/peak6/target/deploy RUST_LOG=error yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'`

**Dependencies**: None.

### 4A: Extract shared script utilities (#5)

**Files** (NEW):
- `scripts/shared.ts`

**Files** (MODIFY):
- `scripts/load-test.ts` — import from shared.ts
- `scripts/create-test-markets.ts` — import from shared.ts

**Changes**:

Extract 5 duplicated utilities to `scripts/shared.ts`:
- `buildPlaceOrderIx` (instruction builder)
- `anchorDiscriminator` (SHA256 sighash helper)
- `padTicker` (import from `services/shared/src/pda.ts` and re-export)
- `readEnv` (.env parser)
- `loadKeypair` (JSON keypair loader)

Both scripts import from this shared file. Read both files carefully before extracting — verify function signatures are identical. The `padTicker` in scripts may use a different approach than `services/shared/src/pda.ts` (Buffer.alloc vs plain encoding) — check before deciding which to keep.

### 4B: Extract test helpers (#6 + additional mediums)

**Files**:
- `tests/helpers/setup.ts` — add `createFundedUser`, `executeMintPair` helpers
- `tests/helpers/index.ts` — re-export new helpers
- `tests/meridian/mint-pair.test.ts` — import helpers
- `tests/meridian/mint-pair-position.test.ts` — import helpers
- `tests/meridian/settlement.test.ts` — import layout constants from helpers

**Changes**:

1. `createFundedUser(ctx, usdcMint, solLamports, usdcAmount) -> { keypair, usdcAta }`: Creates a new keypair, funds with SOL and USDC, returns the keypair and its USDC ATA. Currently duplicated in mint-pair.test.ts and mint-pair-position.test.ts.

2. `executeMintPair(ctx, user, market, amount) -> { yesAta, noAta }`: Builds and sends a mint_pair transaction. Also duplicated.

3. Orderbook layout constants (`OB_DISCRIMINATOR_SIZE`, `OB_ORDER_SLOT_SIZE`, `OB_PRICE_LEVEL_SIZE`, `OB_LEVELS_OFFSET`, `readOrderSlot`): Duplicated in settlement.test.ts and place-order.test.ts. Move to `tests/helpers/orderbook-layout.ts`.

4. PDA derivation functions in `tests/helpers/setup.ts` (lines 73+): 10 functions duplicated from `services/shared/src/pda.ts`. Replace with imports from `services/shared/src/pda.ts`. (The comment says "duplicated for test isolation" but there is no isolation benefit since they compute the same PDAs.)

**IMPORTANT**: Before extracting `createFundedUser`, read both implementations carefully — they may differ in SOL funding amount, USDC amount, or ATA creation approach.

### 4C: Settlement test restructuring (#12 — scope reduction)

**Files**:
- `tests/meridian/settlement.test.ts` (2,932 lines)

**Changes**:

Full decomposition of this file is a large effort. For this sweep, do the **minimum viable restructuring**:

1. Extract the layout helper functions (lines 52-138) to `tests/helpers/orderbook-layout.ts` (already planned in 4B).
2. Extract `advanceClock` helper to `tests/helpers/setup.ts`.
3. Extract `readMarket` / `readMarketFields` / `getTokenBalance` to `tests/helpers/market-layout.ts`.
4. Keep the test suites in the same file for now — splitting into multiple files requires careful analysis of shared mutable state (`ctx`, `usdcMint`, market accounts) and would risk breaking sequential dependencies.

This reduces the file by ~90 lines of helpers and makes future splitting easier.

- [ ] 4A: Create scripts/shared.ts, update both scripts
- [ ] 4B: Extract createFundedUser, executeMintPair to test helpers
- [ ] 4B: Extract orderbook layout constants to test helpers
- [ ] 4B: Replace PDA duplication in tests/helpers/setup.ts with imports
- [ ] 4C: Extract settlement test helpers to shared modules
- [ ] Verify: All on-chain tests pass
- [ ] Verify: `npx tsx scripts/load-test.ts --dry-run` (if available) or syntax check

---

## Stream 5: Frontend Components

**Items**: #1 (OpenOrdersTab + MyOrders cancel duplication), #8 (analytics page ticker JSX duplication), #11 (trade/page.tsx social proof extraction)

**Test command**: `cd app/meridian-web && npx vitest run`

**Dependencies**: Stream 2 (hooks must be stable before component changes).

### 5A: Extract useCancelOrder hook (#1)

**Files** (NEW):
- `app/meridian-web/src/hooks/useCancelOrder.ts`

**Files** (MODIFY):
- `app/meridian-web/src/components/MyOrders.tsx`
- `app/meridian-web/src/components/portfolio/OpenOrdersTab.tsx`

**Changes**:

Both components contain identical cancel logic: derive 9 PDAs, build cancelOrder transaction, send, invalidate 3 query keys. Extract to:

```ts
// hooks/useCancelOrder.ts
export function useCancelOrder(marketKey: string) {
  const { program } = useAnchorProgram();
  const { sendTransaction } = useTransaction();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const cancelOrder = useCallback(async (orderId: bigint, priceLevel: number) => {
    if (!program || !publicKey) return;
    setCancellingId(orderId.toString());
    try {
      const marketPubkey = new PublicKey(marketKey);
      const [config] = findGlobalConfig();
      const [orderBook] = findOrderBook(marketPubkey);
      const [escrowVault] = findEscrowVault(marketPubkey);
      const [yesEscrow] = findYesEscrow(marketPubkey);
      const [noEscrow] = findNoEscrow(marketPubkey);
      const [yesMint] = findYesMint(marketPubkey);
      const [noMint] = findNoMint(marketPubkey);
      const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const userYesAta = await getAssociatedTokenAddress(yesMint, publicKey);
      const userNoAta = await getAssociatedTokenAddress(noMint, publicKey);

      const tx = await program.methods
        .cancelOrder(priceLevel, new BN(orderId.toString()))
        .accountsPartial({
          user: publicKey, config, market: marketPubkey, orderBook,
          escrowVault, yesEscrow, noEscrow,
          userUsdcAta, userYesAta, userNoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      await sendTransaction(tx, { description: "Cancel Order" });
      queryClient.invalidateQueries({ queryKey: ["orderbook"] });
      queryClient.invalidateQueries({ queryKey: ["myOrders"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
    } catch { /* handled by toast */ }
    finally { setCancellingId(null); }
  }, [program, publicKey, marketKey, sendTransaction, queryClient]);

  return { cancelOrder, cancellingId };
}
```

Both components become thin UI shells that call `useCancelOrder(marketKey)`.

### 5B: Extract TickerButton component (#8)

**Files** (NEW):
- `app/meridian-web/src/components/analytics/TickerButton.tsx`

**Files** (MODIFY):
- `app/meridian-web/src/app/analytics/page.tsx`

**Changes**:

The MAG7 section (lines 187-220) and custom section (lines 227-269) contain nearly identical JSX for ticker buttons with quote display. Extract a `TickerButton` component:

```tsx
interface TickerButtonProps {
  ticker: string;
  quote?: { last: number; change: number; change_percentage: number };
  isSelected: boolean;
  onSelect: () => void;
  onRemove?: () => void; // only for custom tickers
}
```

Both sections use `<TickerButton>` with the MAG7 section omitting `onRemove`.

Note: The `TickerSearch` component in analytics/page.tsx duplicates `AddTickerInput` from `WatchlistStrip`. However, they serve different contexts (analytics adds to `extraTickers` state, watchlist adds to watchlist store). Keep them separate unless a common validation-only hook is extracted. For this sweep: document the similarity with a comment, don't merge.

### 5C: Extract trade/page.tsx social proof layer (#11)

**Files** (NEW):
- `app/meridian-web/src/lib/social-proof.ts`

**Files** (MODIFY):
- `app/meridian-web/src/app/trade/page.tsx`

**Changes**:

The trade page (674 lines) mixes fabricated social proof (`tradersActive`, `recentWinPct`, `seededRandom`, the `generateSuggestedTrades` function) with real market data.

Extract to `app/meridian-web/src/lib/social-proof.ts`:
- `seededRandom(seed: string): number`
- `generateSuggestedTrades(quotes): SuggestedTrade[]`
- The `SuggestedTrade` interface

The trade page imports these and calls them. The rendering JSX stays in the page component. This separation makes it clear which data is real and which is fabricated, and allows easy replacement with real data later.

- [ ] 5A: Create useCancelOrder hook, update MyOrders + OpenOrdersTab
- [ ] 5B: Extract TickerButton component from analytics page
- [ ] 5C: Extract social-proof utilities from trade page
- [ ] Verify: `cd app/meridian-web && npx vitest run`
- [ ] Verify: Manual check that trade page and analytics page render correctly

---

## Stream 6: Cleanup Pass

**Items**: #22 (engine.rs exploratory comments), #13 (market-initializer god function), ALL remaining items — every severity level gets fixed, no exceptions.

**Test commands**: All test suites.

**Dependencies**: Streams 1-5 complete.

### 6A: Clean engine.rs comments (#22)

**Files**:
- `programs/meridian/src/matching/engine.rs`

**Changes**:

Lines 140-296 contain 92 lines of exploratory comments ("Wait — let me re-read the spec...", "Actually per the build plan...", "Hmm, the example had..."). These are design-diary entries that helped during development but obscure the actual logic.

Replace the entire comment block above `match_against_asks_merge` (lines 140-171) with a concise 5-line invariant doc:
```rust
/// Match a No-backed bid against Yes asks (merge/burn).
///
/// Matching condition: Yes ask price Q + No bid price P <= 100.
/// No seller gets $(P/100), Yes seller gets $((100-P)/100).
/// Fill price is the resting order's price.
```

Replace the comment block above `match_against_bids` (lines 233-295) similarly:
```rust
/// Match a Yes ask against both USDC bids and No-backed bids.
///
/// For USDC bids: fill when bid_price >= ask_price (standard swap).
/// For No-backed bids: fill when (100 - no_bid_price) >= ask_price (merge/burn).
/// Walks from highest bid price downward (price-time priority).
```

### 6B: Decompose market-initializer (#13)

**Files**:
- `services/market-initializer/src/initializer.ts`

**Changes**:

`initializeMarkets()` (450 lines) has clear phases that are already separated by comments. Extract:
1. `loadConfig(program) -> { configPda, usdcMint }` — lines 92-102
2. `fetchQuotes(tradier, tickers) -> Map<string, Quote>` — lines 105-113
3. `computeMarketCloseUnix()` already exists as a standalone function (good)
4. The `processTickerStrikes` function already exists (lines 175-254) (good)
5. The `createSingleMarket` function already exists (lines 260-413) (good)

The main function `initializeMarkets` is actually already well-decomposed into sub-functions. The 450-line count includes `createSingleMarket` (150 lines) and `processTickerStrikes` (80 lines) which are separate functions. The actual orchestrator is only ~70 lines. **Re-evaluate**: this may not need further decomposition. If the orchestrator reads cleanly, skip this item and document that it was reviewed and deemed acceptable.

### 6C: ALL remaining items (mandatory — every item, every severity)

**Every single item below MUST be fixed. No skipping, no deferring, no "if time permits".**

- [ ] `settlement/settler.ts`: Stringly-typed error code probe — replace `String(msg).includes("6040")` and `includes("OracleStale")` with Anchor error code constants. Define `const ORACLE_STALE_CODE = 6040; const ORACLE_CONF_CODE = 6041;` and match on `e?.error?.errorCode?.number` only.
- [ ] `automation/timezone.ts`: NYSE holiday list requires annual update — add 2028 holidays, add a runtime staleness check: `if (new Date().getFullYear() > maxHolidayYear) log.warn("NYSE holiday list may be stale")`
- [ ] `event-indexer/listener.ts`: Module-level mutable singleton `subscriptionId` — refactor to factory function `createLiveListener()` returning `{ start, stop }` object. Encapsulate `subscriptionId` in closure.
- [ ] `useMarkets.ts parseMarketAccount`: 11× unguarded `BigInt(x.toString())` casts — add null guard: `BigInt((x ?? 0).toString())` for each field. Prevents crash if Anchor returns null on schema upgrade.
- [ ] `tradier-proxy.ts`: Module-level rate limiter not distributed — add comment explicitly documenting this is intentional for single-server Railway deployment and will need Redis backing for multi-instance scale-out.
- [ ] `admin/MarketActions.tsx`: 68-line `handleAction` switch — extract each arm to a named handler function (`handleSettle`, `handleAdminSettle`, `handleOverride`, `handlePause`, `handleUnpause`). Replace switch with handler map lookup.
- [ ] `mm/QuoteTable.tsx`: Per-row `useOrderBook` fires N concurrent subscriptions — add `useMemo` batching or a polling cap comment. If >10 markets, warn in console. Add `// TODO: virtualize for >20 markets` with concrete threshold.
- [ ] `HistoricalOverlay.tsx`: 6 pure math helpers (`computeReturns`, `toWeeklyCloses`, `mean`, `stddev`, `normalPdf`, `buildHistogram`) inlined — extract to `app/meridian-web/src/lib/distribution-math.ts` with unit tests. Also extract the 40-line custom SVG XAxis tick renderer to a named component `<RotatedXAxisTick />`.
- [ ] `SettlementAnalytics.tsx`: Calibration uses `abs(settlementPrice - strikePrice) / strikePrice` as proxy for implied probability (comment at L101 acknowledges this is wrong) — replace with actual fill-price-derived implied probability from event data, or if unavailable, use the midpoint of best bid/ask at settlement time.
- [ ] `portfolio/PnlTab.tsx`: Non-namespaced SVG gradient IDs (`pnlGradientGreen`, `pnlGradientRed`) — namespace with `useId()` or a unique prefix to prevent collision if two instances render.
- [ ] `market-creation.test.ts` + `orderbook-init.test.ts`: Host clock `Date.now()` used for `MARKET_CLOSE_UNIX` instead of bankrun clock — replace with bankrun clock read for consistency.
- [ ] `scripts/load-test.ts`: `placeOrders()` 142 lines with duplicated try/catch block for main vs extra orders — extract common order-placement loop to helper function.
- [ ] `HistoricalOverlay.tsx`: DST calculation duplicated from `trade/page.tsx` — import from shared utility or extract to `lib/market-hours.ts`.

- [ ] 6A: Clean engine.rs exploratory comments
- [ ] 6B: Review market-initializer decomposition (fix if needed)
- [ ] 6C: Fix ALL remaining items listed above — zero exceptions
- [ ] Verify: All test suites pass
- [ ] Verify: `anchor build` succeeds

---

## Execution Checklist

### Phase 1 (Parallel)
- [ ] **Stream 1**: Rust on-chain (signer seeds, place_order decomposition, oracle size assert, merge constant)
- [ ] **Stream 2**: Frontend libs + hooks (normalCdf unify, file duplicates, strikes rounding, portfolio snapshot)
- [ ] **Stream 3**: Service bugs (verify.ts stubs, settlement side effects, oracle-feeder IDL, connect guard, DST fix)
- [ ] **Stream 4**: Scripts + test helpers (shared.ts, test helper extraction, settlement test helpers)

### Phase 2 (After Stream 2)
- [ ] **Stream 5**: Frontend components (useCancelOrder hook, TickerButton, social-proof extraction)

### Phase 3 (Final — CLEAN ALL MESSES)
- [ ] **Stream 6**: Cleanup + ALL remaining items (engine.rs comments, initializer review, every medium/low item fixed)

### Final Verification
- [ ] `anchor build` — clean
- [ ] On-chain tests — all pass
- [ ] Frontend tests — all pass
- [ ] AMM bot tests — all pass
- [ ] Event indexer tests — all pass
- [ ] `cd app/meridian-web && npx next build` — succeeds
- [ ] Git: all changes committed, clean working tree

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| Stream 2B (re-exports) fails due to Next.js transpile boundaries | Fallback: keep as sync-marked copies |
| Stream 1B (place_order decomposition) changes BPF bytecode behavior | Test every existing scenario; compare instruction logs |
| Stream 4B (test helper extraction) breaks test isolation | Run full test suite after each sub-step |
| Stream 3C (oracle-feeder IDL) changes startup behavior | Compare ticker list output before/after |
| Stream 5A (useCancelOrder) changes React render cycle | Verify both components render identical UIs |

---

## Nothing Is Out of Scope

Every item identified in the complexity sweep gets fixed in this plan. No deferrals.
