# Meridian — Development Commands
#
# make dev       — Start frontend + all backend services
# make services  — Start all backend services
# make web       — Start frontend only
# make test      — Run all tests (on-chain + frontend + services)

.PHONY: dev services web test clean

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
	@echo "All services started in background."
	@echo "  - oracle-feeder (Tradier → on-chain oracle)"
	@echo "  - amm-bot (liquidity seeder)"
	@echo "  - event-indexer (on-chain event listener + REST API)"
	@echo "  - automation (scheduler: market-init + settlement)"

# Run all test suites
test:
	yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
	cd app/meridian-web && yarn test run

# Kill background services
clean:
	@pkill -f "oracle-feeder" 2>/dev/null || true
	@pkill -f "amm-bot" 2>/dev/null || true
	@pkill -f "event-indexer" 2>/dev/null || true
	@pkill -f "automation" 2>/dev/null || true
	@pkill -f "next dev" 2>/dev/null || true
	@echo "All services stopped."
