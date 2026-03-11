# Meridian — Development Commands
#
# make install    — Install all dependencies (root + frontend + services)
# make dev        — Start frontend + all backend services
# make services   — Start all backend services
# make web        — Start frontend only
# make test       — Run all tests (on-chain + frontend + services)
# make local      — Start full stack on local validator (no devnet)
# make local-stop  — Stop local validator + all services
# make clean      — Stop all background processes

.PHONY: install dev services web test clean local local-stop stress-test

# Install all dependencies
install:
	yarn install
	cd app/meridian-web && yarn install
	cd services/oracle-feeder && yarn install
	cd services/amm-bot && yarn install
	cd services/event-indexer && yarn install
	cd services/market-initializer && yarn install
	cd services/automation && yarn install
	cd services/monitor && yarn install

# Start everything
dev: web services

# Frontend (Next.js)
web:
	cd app/meridian-web && yarn dev &

# All backend services (long-running processes)
services:
	cd services/oracle-feeder && yarn start &
	cd services/amm-bot && yarn start &
	cd services/event-indexer && yarn start &
	cd services/automation && yarn start &
	cd services/monitor && yarn start &
	@echo "All services started in background."
	@echo "  - oracle-feeder (Tradier -> on-chain oracle)"
	@echo "  - amm-bot (liquidity seeder)"
	@echo "  - event-indexer (on-chain event listener + REST API)"
	@echo "  - automation (scheduler: market-initializer + settlement + verification)"
	@echo "  - monitor (health checks: SOL balance, oracle freshness, expired markets)"

# Run all test suites
test:
	SBF_OUT_DIR=$(shell pwd)/target/deploy yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
	cd app/meridian-web && yarn test run
	cd services/amm-bot && yarn vitest run
	cd services/market-initializer && yarn vitest run
	cd services/event-indexer && yarn vitest run

# Local validator stack (no devnet needed)
local:
	./scripts/local-stack.sh

local-stop:
	./scripts/local-stack.sh --stop

# Stress test against local validator
stress-test:
	@echo "Running Meridian stress test against local validator..."
	npx tsx scripts/stress-test.ts

# Kill background services
clean:
	@pkill -f "oracle-feeder" 2>/dev/null || true
	@pkill -f "amm-bot" 2>/dev/null || true
	@pkill -f "event-indexer" 2>/dev/null || true
	@pkill -f "automation" 2>/dev/null || true
	@pkill -f "monitor" 2>/dev/null || true
	@pkill -f "next dev" 2>/dev/null || true
	@echo "All services stopped."
