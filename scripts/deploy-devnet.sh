#!/usr/bin/env bash
# Deploy meridian + mock_oracle to Solana devnet.
# Idempotent: safe to re-run. Airdrops SOL if balance is low.
# Make executable before first run:  chmod +x scripts/deploy-devnet.sh
set -euo pipefail

MERIDIAN_ID="7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth"
MOCK_ORACLE_ID="HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ"
CLUSTER="devnet"

echo "=== Phase 1B: Deploy to Devnet ==="
echo ""

# ── Step 1: Check SOL balance and airdrop if needed ──────────────────────────
echo "[1/4] Checking SOL balance..."
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

# ── Step 2: Build programs (without IDL — deferred due to toolchain issue) ───
echo "[2/4] Building programs..."
anchor build --no-idl
echo "       Build complete."
echo ""

# ── Step 3: Deploy both programs ─────────────────────────────────────────────
echo "[3/4] Deploying programs to ${CLUSTER}..."

echo "       Deploying meridian..."
anchor deploy --provider.cluster "$CLUSTER" --program-name meridian \
    --program-keypair target/deploy/meridian-keypair.json 2>&1 || {
    echo "       meridian deploy returned non-zero — may already be deployed."
}

echo "       Deploying mock_oracle..."
anchor deploy --provider.cluster "$CLUSTER" --program-name mock_oracle \
    --program-keypair target/deploy/mock_oracle-keypair.json 2>&1 || {
    echo "       mock_oracle deploy returned non-zero — may already be deployed."
}

echo "       Deploy step complete."
echo ""

# ── Step 4: Verify deployments ───────────────────────────────────────────────
echo "[4/4] Verifying deployments..."

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
echo "=== Deploy complete ==="
