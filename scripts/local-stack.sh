#!/usr/bin/env bash
# Start a full Meridian stack on a local Solana validator.
# No devnet, no faucet, no rate limits. Programs run from target/deploy/.
#
# Usage:
#   ./scripts/local-stack.sh          # Start validator + init on-chain state + services + frontend
#   ./scripts/local-stack.sh --init   # Init only (validator already running)
#   ./scripts/local-stack.sh --stop   # Stop everything
#
# Prerequisites:
#   1. anchor build  (programs compiled to target/deploy/)
#   2. yarn install   (JS deps installed)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_RPC="http://localhost:8899"
VALIDATOR_LOG="${REPO_ROOT}/local-validator.log"
MERIDIAN_SO="${REPO_ROOT}/target/deploy/meridian.so"
MOCK_ORACLE_SO="${REPO_ROOT}/target/deploy/mock_oracle.so"
MERIDIAN_ID="7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth"
MOCK_ORACLE_ID="HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[local-stack]${NC} $1"; }
ok()    { echo -e "${GREEN}[local-stack]${NC} $1"; }
warn()  { echo -e "${YELLOW}[local-stack]${NC} $1"; }
fail()  { echo -e "${RED}[local-stack]${NC} $1"; exit 1; }

# ── Stop command ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
  info "Stopping local stack..."
  pkill -f "solana-test-validator" 2>/dev/null && ok "Validator stopped" || warn "No validator running"
  (cd "$REPO_ROOT" && make clean 2>/dev/null) && ok "Services stopped" || warn "No services running"
  exit 0
fi

# ── Pre-flight checks ────────────────────────────────────────────────────────
[[ -f "$MERIDIAN_SO" ]]    || fail "meridian.so not found. Run 'anchor build' first."
[[ -f "$MOCK_ORACLE_SO" ]] || fail "mock_oracle.so not found. Run 'anchor build' first."
command -v solana-test-validator &>/dev/null || fail "solana-test-validator not found. Install Solana CLI."

# ── Start validator (skip if --init) ──────────────────────────────────────────
if [[ "${1:-}" != "--init" ]]; then
  # Kill any existing validator
  pkill -f "solana-test-validator" 2>/dev/null && {
    warn "Killed existing validator, waiting 2s..."
    sleep 2
  }

  info "Starting local validator..."
  info "  meridian    → ${MERIDIAN_ID}"
  info "  mock_oracle → ${MOCK_ORACLE_ID}"

  solana-test-validator \
    --bpf-program "$MERIDIAN_ID" "$MERIDIAN_SO" \
    --bpf-program "$MOCK_ORACLE_ID" "$MOCK_ORACLE_SO" \
    --reset \
    --quiet \
    > "$VALIDATOR_LOG" 2>&1 &

  VALIDATOR_PID=$!
  info "Validator PID: ${VALIDATOR_PID} (log: ${VALIDATOR_LOG})"

  # Wait for validator to be ready
  info "Waiting for validator to start..."
  for i in $(seq 1 30); do
    if solana cluster-version --url "$LOCAL_RPC" &>/dev/null; then
      ok "Validator ready!"
      break
    fi
    if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      fail "Validator process died. Check ${VALIDATOR_LOG}"
    fi
    sleep 1
  done

  # Final check
  solana cluster-version --url "$LOCAL_RPC" &>/dev/null || fail "Validator failed to start after 30s"
fi

# ── Airdrop SOL (unlimited on local) ─────────────────────────────────────────
info "Airdropping 100 SOL to admin..."
ADMIN_ADDR=$(solana address)
solana airdrop 100 --url "$LOCAL_RPC" "$ADMIN_ADDR" > /dev/null 2>&1
BALANCE=$(solana balance --url "$LOCAL_RPC" "$ADMIN_ADDR" | awk '{print $1}')
ok "Admin balance: ${BALANCE} SOL"

# ── Clear any stale USDC_MINT from .env (local validator = fresh state) ───────
ENV_FILE="${REPO_ROOT}/.env"
if grep -q "USDC_MINT" "$ENV_FILE" 2>/dev/null; then
  warn "Clearing stale USDC_MINT/FAUCET_KEYPAIR from .env (fresh local validator)"
  # Remove USDC_MINT, NEXT_PUBLIC_USDC_MINT, and FAUCET_KEYPAIR lines
  sed -i.bak '/^USDC_MINT=/d;/^NEXT_PUBLIC_USDC_MINT=/d;/^FAUCET_KEYPAIR=/d' "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
fi

# ── Install service dependencies (if needed) ──────────────────────────────────
info "Checking service dependencies..."
(cd "$REPO_ROOT" && make install 2>&1 | tail -1)
echo ""

# ── Initialize on-chain state ─────────────────────────────────────────────────
export RPC_URL="$LOCAL_RPC"

info "[1/4] Creating mock USDC mint..."
(cd "$REPO_ROOT" && npx ts-node scripts/create-mock-usdc.ts)
echo ""

info "[2/4] Initializing GlobalConfig..."
(cd "$REPO_ROOT" && npx ts-node scripts/init-config.ts)
echo ""

info "[3/4] Initializing oracle feeds (7 tickers)..."
(cd "$REPO_ROOT" && npx ts-node scripts/init-oracle-feeds.ts)
echo ""

info "[4/4] Creating test markets..."
# ALT creation can fail on first run if slot goes stale during OrderBook allocation.
# Retry once — second run skips market creation (idempotent) and gets a fresh slot for ALT.
if ! (cd "$REPO_ROOT" && npx ts-node scripts/create-test-markets.ts); then
  warn "Market creation hit stale slot (expected on first run). Retrying..."
  sleep 2
  (cd "$REPO_ROOT" && npx ts-node scripts/create-test-markets.ts)
fi
echo ""

# ── Start services ────────────────────────────────────────────────────────────
info "Starting services pointed at local validator..."
export NEXT_PUBLIC_RPC_URL="$LOCAL_RPC"
export NEXT_PUBLIC_SOLANA_RPC_URL="$LOCAL_RPC"

# Source .env for USDC_MINT, TRADIER keys, etc.
set -a
source "$ENV_FILE"
set +a

# Services need keypairs as base58. Derive from admin keypair file.
ADMIN_KP_FILE="${HOME}/.config/solana/id.json"
if [[ -f "$ADMIN_KP_FILE" ]] && [[ -z "${ADMIN_KEYPAIR:-}" ]]; then
  ADMIN_KEYPAIR=$(node -e "
    const bs58 = require('bs58');
    const kp = require('$ADMIN_KP_FILE');
    console.log(bs58.encode(Buffer.from(kp)));
  " 2>/dev/null || true)
  if [[ -n "$ADMIN_KEYPAIR" ]]; then
    export ADMIN_KEYPAIR
    export FEEDER_KEYPAIR="$ADMIN_KEYPAIR"
    ok "Admin/Feeder keypair derived from ${ADMIN_KP_FILE}"
  else
    warn "Could not derive base58 keypair. Oracle-feeder and amm-bot may not start."
    warn "Set ADMIN_KEYPAIR and FEEDER_KEYPAIR env vars manually."
  fi
fi

(cd "$REPO_ROOT" && make services)
echo ""

info "Starting frontend..."
(cd "$REPO_ROOT" && make web)
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}=== Local Stack Running ===${NC}"
echo -e "  Validator:  ${LOCAL_RPC} (PID in background)"
echo -e "  Frontend:   http://localhost:3000"
echo -e "  Event API:  http://localhost:3001"
echo -e "  Programs:   meridian + mock_oracle"
echo -e "  Markets:    AAPL test market"
echo -e ""
echo -e "  ${YELLOW}Stop everything:${NC}  ./scripts/local-stack.sh --stop"
echo -e "  ${YELLOW}Re-init only:${NC}     RPC_URL=${LOCAL_RPC} ./scripts/local-stack.sh --init"
echo -e "  ${YELLOW}Validator log:${NC}    tail -f ${VALIDATOR_LOG}"
