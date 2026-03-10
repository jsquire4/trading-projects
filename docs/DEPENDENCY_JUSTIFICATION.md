# Dependency Justification

This document records why each major dependency was chosen over available alternatives. Versions reflect what is pinned in the project as of Phase 3.

---

## Summary Table

| Category | Dependency | Version | Justification |
|---|---|---|---|
| Framework | Anchor | 0.30.1 | Solana smart contract framework; pinned for stability |
| Token | SPL Token | standard | Standard Solana token program; Token-2022 not needed |
| Frontend | Next.js | 14/15 | App Router for API routes + SSR |
| Frontend | TanStack Query | latest | Server state management, polling, caching |
| Frontend | Tailwind CSS | latest | Utility-first styling |
| Frontend | Recharts | latest | Chart library for analytics dashboard |
| Wallet | @solana/wallet-adapter | latest | Standard Solana wallet integration |
| Data | Tradier API | — | Real MAG7 stock data; REST + streaming |
| Testing | solana-bankrun | latest | In-process Solana tests with clock control |
| Testing | Vitest | latest | ESM-native, fast, React Testing Library compatible |
| Database | better-sqlite3 | latest | Event indexer persistence; lightweight embedded DB |

---

## Detailed Justifications

### Anchor 0.30.1

**Role**: Primary smart contract development framework for Solana.

Anchor provides typed account validation via derive macros (`#[account]`, `#[derive(Accounts)]`), automatic Borsh serialization/deserialization, CPI helpers, IDL generation for TypeScript clients, and integration with the bankrun and anchor-test testing environments. Without Anchor, all account validation, discriminator checks, and PDA derivation would need to be written manually in raw Solana SDK code — significantly more code with no correctness benefit.

The version is pinned at exactly `0.30.1` rather than a range. Anchor has introduced breaking changes between minor versions (account discriminator format, derive macro behavior, IDL schema). Pinning prevents a dependency resolution from pulling in a patch that changes behavior silently. The `anchor-lang`, `anchor-spl`, and `anchor-syn` crates are all locked to the same version.

**Alternatives considered**:
- **Raw Solana SDK**: Too low-level. No account validation macros, no typed instruction builders, no IDL. All constraints and (de)serialization must be written manually. Development time doubles for no benefit.
- **Seahorse**: Python-to-Rust transpiler for Solana. Immature ecosystem, limited ZeroCopy support (required for the ~126KB OrderBook), sparse documentation. Not production-ready.

---

### SPL Token (not Token-2022)

**Role**: Standard fungible token program for Yes/No outcome tokens and mock USDC.

SPL Token is the original Solana token standard. It provides mint, burn, transfer, freeze, and ATA creation — all the operations Meridian needs. The freeze authority on Yes/No mints (held by the market PDA) supports the `pause` instruction. Mint authority (also the market PDA) ensures tokens can only be created via `mint_pair`.

Token-2022 adds transfer hooks, confidential transfers, interest-bearing mints, and the `PermanentDelegate` extension. `PermanentDelegate` would allow force-burning user tokens after market closure — useful for fully closing mints with outstanding supply. However, using it means the admin (or program) can burn any user's tokens at any time, which undermines the non-custodial value proposition even if the capability is only exercised after a multi-year inactivity period. The three-phase market closure lifecycle (`close_market` / `treasury_redeem` / `cleanup_market`) achieves the same economic result — reclaiming ~98% of rent at 90 days while preserving indefinite user access — without requiring force-burn capability.

Token-2022 would also add complexity to every instruction that mints, burns, or transfers tokens. Different account sizes, different initialization flows, different ATA handling. The cost is paid in every phase, not just Phase 6 where the benefit would appear.

**Alternatives considered**:
- **Token-2022**: More features, but more complexity and the `PermanentDelegate` trust liability. Rejected as unnecessary for this prototype.

---

### Next.js 14/15

**Role**: Frontend framework for the trading UI and backend API proxy.

Next.js App Router serves two purposes simultaneously: the React frontend (wallet-connected trading interface, analytics dashboard) and the backend API routes (`/api/tradier/*`) that proxy Tradier REST calls with 60-second TTL caching. Without App Router API routes, a separate backend service would be needed solely for the Tradier proxy — adding operational complexity for a feature that is naturally co-located with the frontend.

SSR support means the landing page and public market listings can be rendered server-side for fast initial load. Wallet-specific components are marked `"use client"` and hydrate on the client.

**Alternatives considered**:
- **Vite + React**: No API routes. A separate backend (Express, Fastify) would be needed for the Tradier proxy. Two services to manage instead of one.
- **Remix**: Less Solana ecosystem support. Most Solana dApp examples, wallet adapter documentation, and community patterns assume Next.js.

---

### TanStack Query

**Role**: Server state management for on-chain account data and REST API responses.

On-chain account data (order book depth, market state, user token balances) changes with every block. TanStack Query's polling with stale-while-revalidate semantics keeps the UI current without manual `useEffect` / `useState` chains for every data source. It handles loading and error states, caches responses, and deduplicates concurrent fetches from multiple components watching the same account.

**Alternatives considered**:
- **SWR**: Similar feature set but less configurable (no query invalidation patterns, weaker cache management). TanStack Query has better TypeScript support and more flexibility for the multi-source data model (RPC accounts + Tradier REST + event indexer REST).
- **Raw `useEffect`**: Error-prone. Each fetch needs manual loading/error state, deduplication, cleanup, and retry logic. Multiplied across 10+ data sources, this becomes unmaintainable.
- **Zustand**: Client state manager, not a server state manager. Suitable for UI state (selected market, active tab) but not for data that originates from RPC calls or HTTP endpoints.

---

### Tailwind CSS

**Role**: Utility-first CSS framework for all UI styling.

Tailwind's utility classes allow rapid iteration without naming debates or stylesheet organization overhead. Spacing, colors, and typography are consistent by default (design token system). The generated CSS bundle only includes classes that are actually used (tree-shaken at build time).

**Alternatives considered**:
- **CSS Modules**: More boilerplate. Each component needs a corresponding `.module.css` file. Naming is still manual. No shared design tokens without additional setup.
- **styled-components / Emotion**: Runtime CSS-in-JS has a performance cost (style injection at render time). No benefit for a project that doesn't need dynamic styles at runtime.
- **Vanilla CSS**: Slowest iteration speed. No design token system without custom properties and manual discipline.

---

### Recharts

**Role**: Chart library for the analytics dashboard (settlement calibration, historical return overlay, implied probability curves).

Recharts is a composable React chart library built on D3. It integrates naturally with React's component model — charts are composed from `<LineChart>`, `<BarChart>`, `<XAxis>`, `<YAxis>`, and `<Tooltip>` components. It has strong TypeScript types and is SSR-compatible (no `window` access at module load time, which matters for Next.js).

**Alternatives considered**:
- **Chart.js / react-chartjs-2**: Configuration-based rather than component-based. Harder to compose with dynamic React state. TypeScript types are less precise.
- **D3 directly**: Maximum flexibility but requires imperative DOM manipulation, which conflicts with React's declarative model. Suitable for highly custom visualizations; overkill for standard line and bar charts.
- **Victory**: Similar to Recharts in composability but smaller community and less active maintenance.

---

### @solana/wallet-adapter

**Role**: Wallet connection and transaction signing for the frontend.

`@solana/wallet-adapter` is the standard Solana wallet integration library. It provides a React context (`WalletProvider`) and hooks (`useWallet`, `useConnection`) that abstract over all major Solana wallets (Phantom, Solflare, Backpack, Ledger). Switching wallets, handling disconnects, and signing transactions are all managed by the adapter layer. All Anchor client libraries are designed to work with wallet adapter's `AnchorProvider`.

**Alternatives considered**:
- **Custom wallet integration**: Reinventing a solved problem. Each wallet (Phantom, Solflare) has a slightly different injection API; the adapter normalizes these. Building this from scratch adds weeks of work for no benefit.
- **WalletConnect**: Primarily an Ethereum standard with limited Solana wallet support. Phantom and Solflare — the two most common Solana wallets — prioritize their own adapter over WalletConnect.

---

### Tradier API

**Role**: Real-time and historical price data for MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA).

Tradier provides streaming WebSocket quotes (zero REST calls during steady-state operation), batch REST quotes (all 7 symbols in 1 call via `symbols=AAPL,MSFT,...`), options chains with Greeks (`greeks=true`), 60-day OHLCV history, and market calendar and clock endpoints. The `prevclose` field in the quote response eliminates a separate REST call for previous closing prices. Rate limits are 60 req/min REST (sufficient — morning startup uses ~10 calls) plus unlimited streaming.

Real market data is required because the product's value proposition is settlement against real stock closing prices. Simulated random walks produce no tradeable signals, expose no timezone or half-day edge cases, and cannot support the options comparison feature (Tradier delta vs Meridian implied probability) or the historical return overlay.

**Alternatives considered**:
- **Pyth/Switchboard on-chain feeds**: No MAG7 equity feeds on Solana devnet. Pyth has some equity feeds on mainnet but coverage is inconsistent and devnet data is unavailable.
- **Yahoo Finance**: No official API. Scraping is against ToS and unreliable. No streaming support.
- **Alpha Vantage**: 5 req/min on the free tier (insufficient for morning burst of 10 calls). No streaming. No options chains with Greeks.
- **Polygon.io**: Good API quality but the free tier has no streaming and rate limits that would require paid upgrade for this use case.
- **Simulated/random data**: Defeats the purpose of a real-world binary outcome product. Settlement against a random number generator is not a meaningful demonstration.

---

### solana-bankrun

**Role**: Fast in-process Solana test runtime for the smart contract test suite.

Bankrun runs Solana program tests in-process without starting a separate validator. This eliminates validator startup time (~30 seconds) per test run. More importantly, it exposes `context.setClock()` — direct clock manipulation that allows tests to simulate time-sensitive scenarios (oracle staleness rejection after 120 seconds, `admin_settle` 1-hour delay, settlement override window expiry) without actually waiting. All 59+ program tests use bankrun for this reason.

**Alternatives considered**:
- **solana-test-validator**: Requires a separate validator process. Slower test iteration (~30s startup). Clock control is limited to `warp_to_slot`, which advances slots but not wall-clock time independently — insufficient for testing staleness thresholds.
- **anchor test (default)**: Uses `solana-test-validator` internally. Same limitations. Also resets state between `describe` blocks, which complicates stateful integration tests.

---

### Vitest

**Role**: Test runner for frontend components and service unit tests.

Vitest is ESM-native, which matches the module format used by the Next.js frontend and the service TypeScript code. It is significantly faster than Jest for watch mode (incremental compilation via Vite's pipeline). It is compatible with React Testing Library and supports the same `describe`/`it`/`expect` API as Jest, making the testing style consistent across the project.

**Alternatives considered**:
- **Jest**: CJS-first. Requires `babel-jest` or `ts-jest` to handle ESM and TypeScript, adding configuration overhead. Slower incremental compilation in watch mode. The project already uses ESM throughout (Anchor TypeScript client, service code, Next.js) — adding CJS transformation layers for tests is unnecessary friction.
- **Playwright**: E2E browser testing. Appropriate for full user flow tests but overkill for unit and component tests. Would supplement Vitest, not replace it.

---

### better-sqlite3

**Role**: Embedded database for the event indexer service.

The event indexer parses `FillEvent` and `SettlementEvent` Anchor logs and persists them for the analytics dashboard and settlement calibration feature. `better-sqlite3` is a synchronous SQLite binding for Node.js — no async complexity, no connection pooling, no network, no separate process. A SQLite file on disk is sufficient for prototype-scale data (hundreds of events per day across 7 markets) and is trivially portable and inspectable.

**Alternatives considered**:
- **PostgreSQL / MySQL**: Full client-server databases with network connections, authentication, and process management. Operationally heavier than necessary for a prototype with a single writer and a handful of readers. Would require a Docker container or managed service.
- **Prisma / Drizzle (ORMs)**: Abstraction layers over the database. Add migration management and type generation, but also add complexity. For a small schema (fills table, settlements table) with known queries, raw SQL via better-sqlite3 is simpler.
- **In-memory store**: No persistence. If the indexer restarts, all historical event data is lost. The indexer is designed to be restartable (queries the RPC for historical logs on startup), but having local storage means replay is a fallback rather than the primary path.
