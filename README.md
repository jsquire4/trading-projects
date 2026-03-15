# Meridian

Binary stock outcome trading platform on Solana. Users trade Yes/No tokens on whether MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) close above a strike price today. Contracts are 0DTE, settle at 4:00 PM ET via on-chain oracle, pay $1 USDC to winners.

## Quick Start

```bash
git clone https://github.com/jsquire4/trading-projects.git
cd trading-projects
cp .env.example .env          # fill in TRADIER_API_KEY and TRADIER_ACCOUNT
make install                  # install all dependencies
make dev                      # start frontend + all backend services
```

## Prerequisites

- Solana CLI 2.1+ — `solana --version`
- Anchor CLI 0.31.1 — `anchor --version`
- Node.js 18+ — `node --version`
- Yarn 1.x — `yarn --version`
- Rust 1.79+ (stable) — `rustc --version`
- Phantom or Solflare wallet (for browser testing)

## Architecture Overview

**Two Solana programs (Anchor 0.30.1)**
- `meridian` — Main trading engine: order book, mint pairs, settlement, redemption
- `mock-oracle` — Price feed program; fed by Tradier brokerage API (swappable for Pyth on mainnet)

**Frontend**
- Next.js 14 with wallet adapter (Phantom/Solflare), TanStack Query, Tailwind CSS, Recharts

**Five backend services**
- `oracle-feeder` — Polls Tradier API and pushes prices on-chain every 30 seconds
- `market-initializer` — Creates daily strike markets at market open for all 7 tickers
- `amm-bot` — Seeds liquidity using Black-Scholes pricing; maintains two-sided order book
- `event-indexer` — Listens for on-chain events and stores them in SQLite; exposes REST API
- `automation` — Scheduler that triggers settlement and post-settlement crank cleanup at 4 PM ET

**Shared utilities**
- `services/shared/` — Common Solana helpers, keypair loading, RPC utilities

## Project Structure

```
├── programs/              # Solana programs (Anchor)
│   ├── meridian/          # Main trading engine
│   └── mock-oracle/       # Price feed oracle
├── app/
│   └── meridian-web/      # Next.js frontend
├── services/
│   ├── oracle-feeder/     # Tradier -> on-chain price feeds
│   ├── market-initializer/ # Daily market creation
│   ├── amm-bot/           # Automated market maker
│   ├── event-indexer/     # On-chain event -> SQLite
│   ├── automation/        # Settlement + crank scheduler
│   └── shared/            # Common utilities
├── scripts/               # Deploy & init scripts
├── tests/                 # On-chain integration tests
└── docs/                  # Specs & plans
```

## Key Commands

| Command | Description |
|---|---|
| `make install` | Install all dependencies (root + frontend) |
| `make dev` | Start everything (frontend + all services) |
| `make services` | Start backend services only |
| `make web` | Start frontend only |
| `make test` | Run all tests (on-chain + frontend + services) |
| `make clean` | Stop all background processes |
| `anchor build` | Build Solana programs |
| `anchor test` | Run on-chain tests (bankrun, no validator needed) |

## Testing

| Suite | Framework | Count |
|---|---|---|
| On-chain (programs) | solana-bankrun + Mocha | 91 tests |
| Frontend | Vitest | 114 tests |
| AMM bot | Vitest | 75 tests |
| Market initializer | Vitest | 19 tests |
| Event indexer | Vitest | 55 tests |
| **Total** | | **354 tests** |

Run the full suite:

```bash
make test
```

Run on-chain tests only:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
```

Run frontend tests only:

```bash
cd app/meridian-web && yarn test run
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values. The only value that requires a real credential is `TRADIER_API_KEY`.

See [.env.example](.env.example) for the full list with comments.

## Deploy to Railway

The project auto-deploys on push to `main` via Railway.

- **Project**: spirited-transformation
- **Repo**: `jsquire4/trading-projects`
- **Services deployed**: meridian-web, oracle-feeder, market-initializer, amm-bot, event-indexer
- Each service directory contains a `railway.toml` with its build and start configuration.

To trigger a deploy manually:

```bash
git push origin main
```

## Differentiator Features (Phase 4)

1. **Vol-aware strike selection** — Strikes chosen at meaningful probability intervals using implied volatility from Tradier options chain
2. **AMM bot with Black-Scholes pricing** — Bot quotes Yes/No prices using N(d2) formula and rebalances around the theoretical fair value
3. **Options comparison** — Side-by-side display of Tradier delta vs Meridian N(d2) for the same underlying and strike
4. **Historical return distribution overlay** — Chart showing historical daily return distribution with the current strike marked
5. **Settlement analytics** — Calibration curves, resolution accuracy, and a leaderboard of top traders
6. **Binary Greeks display** — Displays delta, gamma, theta, and vega computed for binary (digital) options

## Documentation

- [Build Plan](docs/BUILD_PLAN.md) — Full implementation plan and architecture decisions
- [Order Book Spec](docs/ORDER_BOOK.md) — Order book schema, matching engine, escrow model, settlement paths
- [Dev Log](docs/DEV_LOG.md) — Decision reasoning, spec deviations, dependency justification
- [Spec](docs/Meridian%20-%20Binary%20Stock%20Outcome%20Markets%20on%20Blockchain.md) — Original assignment requirements

## Known Risks & Limitations

### On-Chain
- **Pyth oracle not yet integrated.** `settle_market` only supports `oracle_type=0` (mock oracle). Pyth settlement (type=1) requires `admin_settle` fallback until full Pyth integration. Not a blocker for devnet.
- **Override window is 1 second.** Effectively instant finality — admin has minimal time to dispute oracle prices post-settlement. Intentional for devnet speed; should be configurable (via GlobalConfig) for mainnet.
- **`obligations` field is new.** Treasury withdrawal cap (`balance - obligations`) is now enforced, but existing deployed accounts have `obligations = 0`. First settlement after upgrade will initialize the field correctly.
- **Conflicting position constraint.** Users cannot hold both Yes and No tokens on the same strike. This blocks same-strike straddles and limits market-maker flexibility. Cross-strike positions are unrestricted.
- **Early close detection is brittle.** NYSE half-day dates (1 PM close) are hardcoded through 2028. Falls back to 4 PM if stale or Yahoo is unreachable.
- **max_fills = 50 with ALT, 10 without.** Large sweeps across many price levels may leave a remainder as a resting limit order if liquidity is spread across 50+ levels.

### Services
- **Yahoo Finance is the sole market data source.** Unofficial API (yahoo-finance2 npm), no SLA. Rate limit ~100-200 req/min in practice. If Yahoo is down, oracle prices go stale and settlement uses last-known prices after 30-min timeout.
- **Market state detection relies on single AAPL quote.** If AAPL is halted, the entire system thinks the market is closed. Should query multiple tickers for consensus.
- **Circuit breaker state is in-memory.** If the oracle feeder restarts, it forgets that it tripped the circuit breaker. The on-chain pause state persists independently.

### Frontend
- **`todayPnl` is all-time unrealized P&L**, not intraday. The event-indexer doesn't provide intraday snapshots, so true daily P&L is not available.
- **NavPnl uses 50¢ fallback** for mid-price when order book data isn't available (approximate flag shown).
- **Dead components remain in the codebase.** `OrderForm.tsx`, `MarketCard.tsx`, `PayoffDisplay.tsx`, `DepthChart.tsx`, `RedeemPanel.tsx` are deprecated but not deleted (some have test dependencies).

### Deployment
- **Railway services need rootDirectory set manually** via the dashboard. CLI can't set this.
- **No database.** Event indexer uses flat-file storage. Production would need Postgres for reliability.

## License

MIT
