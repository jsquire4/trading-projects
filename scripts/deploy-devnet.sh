#!/usr/bin/env bash
# Deploy meridian + mock_oracle to Solana devnet, then initialize all on-chain state.
# Idempotent: safe to re-run from any state. Each step is skipped if already complete.
# Make executable before first run:  chmod +x scripts/deploy-devnet.sh
set -euo pipefail

MERIDIAN_ID="7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth"
MOCK_ORACLE_ID="HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ"
CLUSTER="devnet"

# Resolve repo root (the directory containing this script's parent)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Meridian Devnet Deploy ==="
echo "    Repo root: ${REPO_ROOT}"
echo ""

# ── Step 1: Check SOL balance and airdrop if needed ──────────────────────────
echo "[1/8] Checking SOL balance..."
BALANCE_RAW=$(solana balance --url "$CLUSTER" | awk '{print $1}')
# Strip decimals for integer comparison (bash can't do floats)
BALANCE_INT=${BALANCE_RAW%%.*}

echo "       Current balance: ${BALANCE_RAW} SOL"

if [ "$BALANCE_INT" -lt 2 ]; then
    echo "       Balance below 2 SOL — requesting airdrop..."
    MAX_RETRIES=5
    for i in $(seq 1 $MAX_RETRIES); do
        if solana airdrop 2 --url "$CLUSTER" 2>/dev/null; then
            break
        fi
        echo "       Airdrop attempt $i/$MAX_RETRIES failed (rate limited). Waiting 15s..."
        sleep 15
    done
    NEW_BALANCE=$(solana balance --url "$CLUSTER" | awk '{print $1}')
    echo "       New balance: ${NEW_BALANCE} SOL"
    NEW_INT=${NEW_BALANCE%%.*}
    if [ "$NEW_INT" -lt 1 ]; then
        echo "       ERROR: Could not airdrop SOL. Visit https://faucet.solana.com manually."
        echo "       Wallet: $(solana address)"
        exit 1
    fi
else
    echo "       Balance sufficient, skipping airdrop."
fi

echo ""

# ── Step 2: Install JS dependencies ──────────────────────────────────────────
echo "[2/8] Installing JS dependencies..."
(cd "$REPO_ROOT" && yarn install --frozen-lockfile 2>&1)
echo "       Dependencies up to date."
echo ""

# ── Step 3: Build programs ────────────────────────────────────────────────────
echo "[3/8] Building programs..."
(cd "$REPO_ROOT" && anchor build)
echo "       Build complete."
echo ""

# ── Step 4: Deploy both programs ─────────────────────────────────────────────
echo "[4/8] Deploying programs to ${CLUSTER}..."

echo "       Deploying meridian..."
(cd "$REPO_ROOT" && anchor deploy --provider.cluster "$CLUSTER" --program-name meridian \
    --program-keypair target/deploy/meridian-keypair.json 2>&1) || {
    echo "       meridian deploy returned non-zero — may already be deployed at same bytecode."
}

echo "       Deploying mock_oracle..."
(cd "$REPO_ROOT" && anchor deploy --provider.cluster "$CLUSTER" --program-name mock_oracle \
    --program-keypair target/deploy/mock_oracle-keypair.json 2>&1) || {
    echo "       mock_oracle deploy returned non-zero — may already be deployed at same bytecode."
}

echo "       Deploy step complete."
echo ""

# ── Step 5: Verify program deployments ───────────────────────────────────────
echo "[5/8] Verifying program deployments..."

echo "       meridian (${MERIDIAN_ID}):"
solana program show "$MERIDIAN_ID" --url "$CLUSTER" 2>&1 | head -5 || {
    echo "       WARNING: Could not verify meridian deployment."
}

echo ""
echo "       mock_oracle (${MOCK_ORACLE_ID}):"
solana program show "$MOCK_ORACLE_ID" --url "$CLUSTER" 2>&1 | head -5 || {
    echo "       WARNING: Could not verify mock_oracle deployment."
}

echo ""

# ── Step 6: Create mock USDC mint ────────────────────────────────────────────
echo "[6/8] Creating mock USDC mint (idempotent)..."
(cd "$REPO_ROOT" && npx ts-node scripts/create-mock-usdc.ts)
echo ""

# ── Step 7: Initialize GlobalConfig and oracle feeds ─────────────────────────
echo "[7/8] Initializing on-chain accounts (idempotent)..."

echo "  [7a] GlobalConfig..."
(cd "$REPO_ROOT" && npx ts-node scripts/init-config.ts)
echo ""

echo "  [7b] Oracle price feeds..."
(cd "$REPO_ROOT" && npx ts-node scripts/init-oracle-feeds.ts)
echo ""

# ── Step 8: Create test markets ──────────────────────────────────────────────
echo "[8/8] Creating test markets (idempotent)..."
(cd "$REPO_ROOT" && npx ts-node scripts/create-test-markets.ts)
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Deploy complete ==="
echo "    Programs:  2 (meridian, mock_oracle)"
echo "    Feeds:     7 (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA)"
echo "    Markets:   1 (AAPL strike market)"
echo "    Cluster:   ${CLUSTER}"
echo "    Wallet:    $(solana address)"
