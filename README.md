# Meridian

Binary stock outcome trading platform on Solana. Users trade Yes/No tokens on whether MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) close above a strike price today. Contracts are 0DTE, settle at 4:00 PM ET via on-chain oracle, pay $1 USDC to winners.

## One-Command Local Setup

```bash
# Prerequisites: Solana CLI 2.1+, Anchor CLI 0.31.1, Node 18+, Yarn 1.x, Rust 1.79+
anchor build                  # compile Solana programs (~2 min first time)
make local                    # everything else — validator, init, services, frontend
```

`make local` runs `scripts/local-stack.sh` which:
1. Starts a local Solana validator with both programs loaded
2. Airdrops SOL to admin, creates mock USDC mint
3. Initializes GlobalConfig (admin, oracle refs, treasuries)
4. Initializes TickerRegistry and adds all 7 MAG7 tickers
5. Initializes oracle price feeds for all 7 tickers
6. Creates ~37 strike markets with Black-Scholes-priced liquidity (3 bid + 3 ask levels each)
7. Starts all backend services + frontend

Open http://localhost:3000 and connect a Phantom/Solflare wallet (set to localhost).

To stop everything: `make local-stop`

## Deploy to Solana Devnet

```bash
anchor build                           # compile programs
./scripts/deploy-devnet.sh             # deploy + initialize (idempotent, ~3 min)
```

The script handles: SOL balance check, program deployment, mock USDC mint, GlobalConfig init, oracle feeds, and test market creation. Re-running is safe — each step is skipped if already complete.

After deployment, point the frontend and services at devnet:

```bash
# In .env:
SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com

make dev    # start frontend + services pointed at devnet
```

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Solana CLI | 2.1+ | `solana --version` |
| Anchor CLI | 0.31.1 | `anchor --version` |
| Node.js | 18+ | `node --version` |
| Yarn | 1.x | `yarn --version` |
| Rust | 1.79+ (stable) | `rustc --version` |

A Solana keypair at `~/.config/solana/id.json` is required. Create one with `solana-keygen new` if needed.

## Architecture

> **Full architecture deep-dive:** See the [interactive architecture summary](app/meridian-web/public/architecture.html) for exhaustive coverage of PDA seeds, account layouts, matching engine internals, fee/treasury mechanics, service polling intervals, frontend hooks, and the complete glossary. Accessible at `/architecture.html` on the live deployment.

**Two Solana programs (Anchor 0.31.1)**
- `meridian` — Main trading engine: on-chain CLOB order book, mint pairs, settlement, redemption
- `mock_oracle` — Price feed program; fed by Yahoo Finance API (swappable for Pyth on mainnet)

**Frontend** — Next.js 14 with Solana wallet adapter, TanStack Query, Tailwind CSS, Recharts

**Backend services** (all in `services/`)
| Service | Purpose |
|---------|---------|
| `oracle-feeder` | Pushes stock prices on-chain every 30s (Yahoo Finance or synthetic mode) |
| `settlement` | Reactive poller: settles expired markets, cranks cancels/redeems, closes markets |
| `market-initializer` | Creates daily strike markets for all 7 tickers |
| `automation` | Morning health check, schedule coordination |
| `monitor` | SOL balance alerts, oracle staleness checks |
| `event-indexer` | Listens for on-chain events, stores in SQLite, exposes REST API |
| `amm-bot` | Seeds liquidity using Black-Scholes pricing (optional, for demos) |

## Project Structure

```
programs/
  meridian/           # Main trading program (Rust/Anchor)
  mock-oracle/        # Oracle price feed program
app/
  meridian-web/       # Next.js frontend
services/
  settlement/         # Settlement pipeline
  oracle-feeder/      # Price feed service
  market-initializer/ # Daily market creation
  automation/         # Scheduler
  monitor/            # Health checks
  event-indexer/      # Event storage + REST API
  amm-bot/            # AMM liquidity bot
  shared/             # Common utilities
scripts/
  deploy-devnet.sh    # Devnet deployment (idempotent)
  local-stack.sh      # Local validator + full stack
  create-mock-usdc.ts # Mock USDC mint creation
  init-config.ts      # GlobalConfig initialization
  init-oracle-feeds.ts # Oracle feed initialization
  create-test-markets.ts # Test market creation
tests/
  meridian/           # On-chain integration tests (bankrun)
  mock-oracle/        # Oracle tests
  helpers/            # Test utilities
```

## Key Commands

| Command | Description |
|---------|-------------|
| `anchor build` | Compile Solana programs |
| `make local` | Start full local stack (validator + init + services + frontend) |
| `make local-stop` | Stop everything |
| `make install` | Install all dependencies (root + frontend + services) |
| `make dev` | Start frontend + all backend services (no validator) |
| `make services` | Start backend services only |
| `make web` | Start frontend only |
| `make test` | Run all test suites |
| `make clean` | Stop all background processes |

## Testing

```bash
make test    # run everything
```

| Suite | Framework | Tests |
|-------|-----------|-------|
| On-chain programs | solana-bankrun + Mocha | 167 |
| Frontend | Vitest | 114 |
| AMM bot | Vitest | 75 |
| Market initializer | Vitest | 19 |
| Event indexer | Vitest | 55 |

On-chain tests cover: all 8 required instructions, settlement (at/above/below strike), vault balance invariant ($1 per pair), oracle validation (stale/confidence/valid), admin override with time delay, full lifecycle (create → mint → trade → settle → redeem), all 4 trade paths (Buy Yes, Buy No, Sell Yes, Sell No), and multi-user scenarios.

## Environment Variables

Copy `.env.example` to `.env`. For local development, no external credentials are needed — synthetic mode generates price data internally.

For devnet with live market data, set `MARKET_DATA_SOURCE=live` (uses Yahoo Finance, no API key required).

See [.env.example](.env.example) for the full list with comments.

## Smart Contract Functions

| Instruction | Description |
|-------------|-------------|
| `initialize_config` | One-time global setup: admin, tickers, oracle references |
| `create_strike_market` | Create a market for one stock/strike/day (Yes/No mints, vault, order book) |
| `add_ticker` | Register a new ticker in the TickerRegistry |
| `mint_pair` | Deposit $1 USDC → receive 1 Yes + 1 No token |
| `place_order` | Post a limit/market order on the CLOB |
| `cancel_order` | Cancel a resting order, refund escrow |
| `settle_market` | Permissionless: read oracle price, write binary outcome |
| `admin_settle` | Admin fallback with 5-minute delay |
| `admin_override_settlement` | Correct a settlement within the override window |
| `redeem` | Burn winning tokens for $1 USDC each, or pair-burn for $1 |
| `pause` / `unpause` | Emergency circuit breaker (global) |
| `crank_cancel` / `crank_redeem` | Batch process cancels and redemptions post-settlement |
| `close_market` | Drain accounts, recover SOL rent after all tokens redeemed |

## Daily Lifecycle

1. **~8:00 AM ET** — Market initializer reads previous close, generates ±3/6/9% strikes, creates on-chain markets
2. **9:00 AM ET** — Markets visible on frontend, minting and trading enabled
3. **9:30 AM–4:00 PM ET** — Live trading on the order book
4. **~4:05 PM ET** — Settlement service reads oracle closing price, settles all contracts
5. **Post-settlement** — Crank cancel (refund resting orders), crank redeem (auto-redeem winners), close markets (recover rent)

## Known Risks & Limitations

### On-Chain
- **Mock oracle only.** `settle_market` supports `oracle_type=0` (mock). Pyth integration (type=1) requires `admin_settle` fallback. Not a blocker for devnet.
- **Override window is 1 second.** Effectively instant finality — admin has minimal dispute time. Intentional for devnet; should be configurable for mainnet.
- **Position constraints enforced.** Users cannot hold both Yes and No tokens for the same strike from trading (pair-burn is the exit). This blocks same-strike straddles by design.
- **Early close dates hardcoded through 2028.** NYSE half-day schedule. Falls back to 4 PM if stale.

### Services
- **Yahoo Finance is the sole market data source** (unofficial API). If Yahoo is down, oracle prices go stale and settlement falls back to admin_settle after timeout.
- **Market state detection relies on AAPL quote.** If AAPL is halted, the system thinks the market is closed.
- **Circuit breaker checks on-chain pause at startup.** If the platform is paused, the oracle feeder starts in paused mode.

### Frontend
- **`todayPnl` is all-time unrealized P&L**, not intraday. The label is documented; true daily P&L requires intraday snapshots not yet implemented.

## License

MIT
