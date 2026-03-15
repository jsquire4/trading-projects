#!/usr/bin/env bash
# Deploy meridian + mock_oracle to Solana devnet, then initialize all on-chain state.
# Idempotent: safe to re-run from any state. Each step is skipped if already complete.
# Make executable before first run:  chmod +x scripts/deploy-devnet.sh
set -euo pipefail

MERIDIAN_ID="G5zZw1GMzqwjfbRMjTi2qUXDwoUwLw83hjEuwLfVCZvy"
MOCK_ORACLE_ID="Az6BVaQwfoSqDyyn3TyvgfavoVKN4Qm8wLbMWm5EceFC"
CLUSTER="devnet"

# Resolve repo root (the directory containing this script's parent)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Meridian Devnet Deploy ==="
echo "    Repo root: ${REPO_ROOT}"
echo ""

# ── Step 1: Check SOL balance ─────────────────────────────────────────────────
echo "[1/8] Checking SOL balance..."
BALANCE_RAW=$(solana balance --url "$CLUSTER" | awk '{print $1}')
BALANCE_INT=${BALANCE_RAW%%.*}

echo "       Current balance: ${BALANCE_RAW} SOL"

if [ "$BALANCE_INT" -lt 4 ]; then
    echo ""
    echo "       WARNING: Balance is below 4 SOL. Deploy requires ~3-4 SOL."
    echo "       Fund your wallet manually at: https://faucet.solana.com"
    echo "       Wallet: $(solana address)"
    echo ""
    read -rp "       Continue anyway? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo "       Aborting. Fund your wallet and re-run."
        exit 1
    fi
else
    echo "       Balance sufficient."
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
