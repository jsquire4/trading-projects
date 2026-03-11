# Pre-Deployment Testing & Launch Checklist

Last updated: 2026-03-11

## Where Things Stand

### Completed

| Layer | Status | Evidence |
|---|---|---|
| On-chain programs (meridian + mock_oracle) | Built, deployed to devnet, 91 on-chain tests | `anchor build` succeeds, programs live on devnet |
| Frontend (Next.js) | Feature-complete, 114 tests | Wallet connect, order placement, trade history, analytics |
| Backend services (5) | Feature-complete, 149 tests | oracle-feeder, amm-bot, event-indexer, market-initializer, monitor |
| CI/CD | 3-job GitHub Actions + Railway auto-deploy | `.github/workflows/ci.yml`, Railway project `spirited-transformation` |
| Security audit | 32 issues found and fixed | Post-Phase-5 sweep: maker payout theft, escrow dust, OB overflow, etc. |
| Stress test | Written, not yet executed | `scripts/stress-test.ts` — 6 phases, 21 markets, 100 wallets, 1000+ txns |
| Documentation | BUILD_PLAN, ORDER_BOOK, ARCHITECTURE, RISKS, DEV_LOG, README | `docs/` directory |

### Not Yet Done

| Item | Blocker | Priority |
|---|---|---|
| Run stress test on local validator | None — just needs `make local` then `make stress-test` | **HIGH** |
| Devnet integration test (live Tradier data) | None — deploy scripts are idempotent | **HIGH** |
| Load test on devnet (rate-limited) | Devnet faucet limits SOL airdrops | MEDIUM |
| Mainnet oracle swap (mock → Pyth) | Out of scope for prototype | N/A |

---

## Testing Plan

### Step 1: Local Stress Test

Proves all 15 instruction types work end-to-end with real Solana transactions.

```bash
# Terminal 1: Start local validator + initialize on-chain state + services
./scripts/local-stack.sh

# Terminal 2: Run stress test (takes ~4-5 min)
make stress-test
```

**What it exercises:**
- Phase 1: Create 21 markets (7 tickers × 3 strikes), oracle feeds, ALTs
- Phase 2: Fund 100 wallets (SOL airdrop + USDC mint)
- Phase 3: Mint Yes/No token pairs on 14 trading markets
- Phase 4: ~1,000+ orders (resting, crossing, no-backed, cancels, market orders)
- Phase 5: Settle 7 lifecycle markets (3 oracle, 4 admin) + pair-burn redemptions
- Phase 6: close_market → treasury_redeem → cleanup_market

**Acceptance criteria (auto-checked):**
- AC-1: All 21 markets created
- AC-2: Order success rate >= 80%
- AC-3: All 7 lifecycle markets settled
- AC-4: Lifecycle markets closed (or SKIP if override window active — rerun with `--resume` after 1h)
- AC-5: Zero vault invariant violations
- AC-6: Total txn count > 500
- AC-7: >= 10 of 15 instruction types exercised

**If Phase 6 SKIPs** (override window = 1h after settlement):
```bash
# Wait 1 hour, then:
npx tsx scripts/stress-test.ts --resume
```

### Step 2: Manual Frontend Smoke Test (Local)

With local stack running after the stress test, open `http://localhost:3000`:

1. Connect Phantom/Solflare wallet (devnet or localhost)
2. Verify markets load with order book depth (from stress test's resting orders)
3. Place a limit buy order on any trading market
4. Place a limit sell order that crosses → verify fill
5. Cancel a resting order → verify refund
6. Navigate to `/history` → verify trade history populates
7. Check `/analytics` page renders charts
8. Use USDC faucet button → verify balance increases

### Step 3: Devnet Deployment + Integration Test

```bash
# Deploy programs + initialize on-chain state (idempotent)
./scripts/deploy-devnet.sh

# Start services pointing at devnet
make services

# Start frontend
make web
```

**Verify:**
1. Programs deployed: `solana program show <PROGRAM_ID> --url devnet`
2. GlobalConfig exists on-chain
3. Oracle feeds update from Tradier (check oracle-feeder logs)
4. Market-initializer creates today's markets at 9:30 AM ET
5. AMM bot places quotes on active markets
6. Frontend connects to devnet, shows real-time prices
7. Place a trade via the frontend → confirm on Solana Explorer

### Step 4: Railway Deployment

Railway auto-deploys on push to `main`. After push:

1. Check Railway dashboard (`spirited-transformation` project) — all 5 services healthy
2. Verify frontend health check: `curl https://<railway-domain>/`
3. Verify event-indexer health: `curl https://<event-indexer-domain>/api/health`
4. Monitor service logs for errors (Railway dashboard → Logs)

---

## Environment Variables Checklist

### Required for Devnet

| Variable | Where | How Set |
|---|---|---|
| `TRADIER_API_KEY` | `.env` | Manual (already present) |
| `TRADIER_ACCOUNT` | `.env` | Manual (already present) |
| `SOLANA_RPC_URL` | `.env` | Default: `https://api.devnet.solana.com` |
| `USDC_MINT` | `.env` | Auto-created by `deploy-devnet.sh` |
| `FAUCET_KEYPAIR` | `.env` | Auto-created by `create-mock-usdc.ts` |
| `NEXT_PUBLIC_RPC_URL` | `.env` / frontend `.env` | Must match `SOLANA_RPC_URL` |
| `NEXT_PUBLIC_USDC_MINT` | `.env` / frontend `.env` | Must match `USDC_MINT` |
| `NEXT_PUBLIC_EVENT_INDEXER_URL` | frontend `.env` | Railway URL or `http://localhost:3001/api` |

### Required for Railway

Same as devnet, plus set as Railway service environment variables in the dashboard. Each service needs:
- `SOLANA_RPC_URL`
- `ADMIN_KEYPAIR` (base58 or JSON array)
- `USDC_MINT`
- Service-specific vars (see `.env.example`)

---

## Known Limitations for Devnet

| Limitation | Impact | Mitigation |
|---|---|---|
| Devnet SOL faucet rate-limited | Can't stress-test with 100 wallets | Use local validator for stress test; devnet for integration only |
| Mock oracle (not Pyth) | Prices come from Tradier via our service, not a decentralized oracle | Documented in RISKS_AND_LIMITATIONS.md; swappable on mainnet |
| Self-trade allowed | No economic harm, just wasteful gas | Frontend-only prevention; documented |
| Position constraints frontend-only | Users could hold Yes+No via direct transfer | SPL tokens are transferable by design; documented |
| 0DTE only | Markets expire same day, no multi-day positions | By spec design |

---

## Quick Reference

```bash
# Build everything
anchor build && make install

# Run all 482 tests (no validator needed)
make test

# Local integration (full stack)
./scripts/local-stack.sh          # start
make stress-test                  # stress test
./scripts/local-stack.sh --stop   # stop

# Devnet deploy (idempotent)
./scripts/deploy-devnet.sh

# Start services + frontend
make dev
```
