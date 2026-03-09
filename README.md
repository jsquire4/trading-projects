# Meridian

Binary stock outcome markets on Solana. Users trade Yes/No tokens on whether MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) close above a strike price today. Contracts are 0DTE, settle at 4:00 PM ET via on-chain oracle, pay $1 USDC to winners.

## Quick Start

```bash
make dev
```

## Prerequisites

- Rust 1.75+
- Solana CLI 1.18+
- Anchor CLI 0.30.x
- Node.js 18+ (LTS)
- Yarn
- Tradier API key (brokerage account)
- Phantom or Solflare wallet (for browser testing)

## Setup

```bash
cp .env.example .env
# Fill in your Tradier API key and account ID
```

## Project Structure

```
meridian/
├── programs/
│   ├── meridian/           # Main trading program (Rust/Anchor)
│   └── mock-oracle/        # Price feed program (Rust/Anchor)
├── app/meridian-web/       # Next.js frontend
├── services/
│   ├── oracle-feeder/      # Tradier → on-chain oracle
│   ├── amm-bot/            # Liquidity seeding bot
│   └── market-initializer/ # Daily market creation + settlement
├── tests/                  # Anchor integration tests
├── scripts/                # Deploy, init, lifecycle scripts
└── docs/                   # Architecture, planning, dev log
```

## Documentation

- [Build Plan](docs/BUILD_PLAN.md) — Full implementation plan with architecture decisions
- [Order Book Spec](docs/ORDER_BOOK.md) — Order book schema, matching engine, escrow model, settlement paths
- [Dev Log](docs/DEV_LOG.md) — Decision reasoning, spec deviations, dependency justification
- [Spec](docs/Meridian%20-%20Binary%20Stock%20Outcome%20Markets%20on%20Blockchain.md) — Original assignment requirements

## Status

In development — Phase 1 (Foundation).
