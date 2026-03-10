# Risks and Limitations

This document records known trust assumptions, technical limitations, economic edge cases, and the prototype scope of the Meridian system. Items here are deliberate and documented — not oversights.

---

## Trust Assumptions

### Admin Key

A single admin keypair controls market creation, settlement fallback, settlement override, and global/per-market pause. There is no on-chain governance or multisig for these operations.

Mitigations in place:
- `admin_settle` (manual settlement) requires a 1-hour delay after market close — the oracle has 1 hour to settle first, making admin settlement a last resort.
- `admin_override_settlement` is capped at 3 uses per market (3 hours total). After the cap or after the deadline passes, the outcome is truly final and cannot be changed.
- The override window blocks winner/loser redemptions, preventing payouts on a potentially incorrect outcome while a correction is in progress.
- `crank_cancel` (escrow refunds) is not blocked during the override window — escrow returns are outcome-independent.

On devnet: the admin key is the same as the deployer keypair (`~/.config/solana/id.json`). On mainnet, a separate dedicated keypair would be used, with upgrade authority eventually transferred to a multisig (Squads) once the system stabilizes.

### Oracle Trust

The mock oracle on devnet relies on a single authority keypair to write prices. If the oracle authority key were compromised, an attacker could write arbitrary prices and influence settlement outcomes.

The oracle feeder validates Tradier API data before writing it on-chain (checks for zero prices, verifies the timestamp is not in the future), and the settlement instruction validates staleness (≤ 120 seconds) and confidence band (≤ 0.5% of price) before accepting any oracle price for settlement.

On mainnet, the mock oracle would be replaced with Pyth (a decentralized oracle network with multiple independent price publishers and on-chain aggregation). The `oracle_type` field in GlobalConfig and the branching logic in `settle_market` support this swap without redeploying the meridian program.

### Single Oracle Source

On devnet, all price data originates from the Tradier API — a single data provider. If Tradier's data is incorrect for a given closing price (e.g., delayed, adjusted, or erroneous), the settlement outcome may not reflect the true market close. Settlement prices can be verified against public sources (Yahoo Finance, Bloomberg) after the fact, and the admin override window provides a 1-hour correction path.

---

## Technical Limitations

### Position Constraints Are Not Fully Enforceable

The system enforces position constraints on-chain at the two entry points where a user can enter a conflicting state:
- `place_order` side=0 (Buy Yes): rejects if the user's No ATA balance for this market is greater than zero.
- `mint_pair`: rejects if the user's Yes ATA balance for this market is greater than zero.

However, SPL tokens are freely transferable. A user could transfer No tokens to a second wallet, then buy Yes from the first wallet, holding both tokens across two accounts. This requires deliberate effort and represents the user's own capital inefficiency (holding both Yes and No is equivalent to holding cash at the risk-free rate). It is not a safety or solvency risk to the protocol.

The on-chain check prevents the common case — a single-wallet user making a mistake. The multi-wallet circumvention is documented as a known remaining limitation, scoped accurately as a circumvention requiring deliberate action rather than a missing check.

### Self-Trade Prevention Not Implemented

A user can fill their own resting orders by taking the opposite side. There is no on-chain check that prevents this. There is no economic harm — the user simply pays themselves at their own price, with round-trip fees. It is wasteful but not exploitable. Implementing self-trade prevention would add complexity and CU cost to every order match. Documented and accepted for the prototype.

### 90-Day Redemption Window (Mainnet Only)

The spec states unredeemed tokens are redeemable indefinitely. On mainnet, leaving all market accounts open indefinitely accumulates rent without bound. The Phase 6 `close_market` instruction partially closes a market 90 days post-settlement (reclaims ~98% of rent), sweeping remaining vault USDC to a Treasury PDA.

User rights do not expire at 90 days. `treasury_redeem` (no time limit) allows any token holder to redeem winning tokens against the Treasury PDA indefinitely. The 90-day window is when funds move from the market vault to treasury, not when user access ends. The settlement record (`StrikeMarket`) and mints remain open until all outstanding tokens are burned.

This deviation from the spec's "indefinitely redeemable" language is strictly necessary for mainnet sustainability and is called out explicitly in the frontend UI (countdown timer, treasury claim flow).

### Order Book Capacity

Each price level holds a maximum of 16 order slots. If all 16 slots at a given price are occupied, new orders at that level are rejected with `OrderBookFull`. The frontend should display a message directing the user to a different price level.

At prototype scale (7 markets, AMM bot plus a handful of real users), 16 slots per level is sufficient. On mainnet, the minimum order size (`MIN_ORDER_SIZE`) would be raised to make filling all slots at a single price economically costly.

### No Partial Fills Per Order

The matching engine fills orders at each price level in FIFO order. A single order match either fills the resting order completely or reduces it by the incoming order's quantity. There is no partial fill of the incoming order at a single price level — if quantity remains after exhausting one level, matching continues to the next level (up to `max_fills` fills per instruction call).

`redeem` burns all of a user's tokens for a market in one call. Users who want to redeem only a portion of their position must transfer the remainder to a second wallet before calling redeem. The spec does not require partial redemption; a `quantity` parameter can be added later if needed.

---

## Economic Edge Cases

### AMM Bot Inventory Imbalance

The AMM bot quotes both sides of every market. In fast-moving markets, the bot may fill heavily on one side before its inventory skew mechanism or circuit breaker triggers. If the bot's Yes or No inventory becomes one-sided, it stops quoting until inventory is reconciled (by redeeming pairs or waiting for the opposite side to fill). During this period, the market has reduced liquidity. The bot is a convenience feature — all markets remain fully functional for manual trading regardless of AMM state.

### Settlement at Exactly the Strike

The settlement operator is `>=`: if the closing price is greater than or equal to the strike, Yes wins. If a stock closes at exactly the strike price, Yes wins. This is documented behavior, not an edge case — the `>=` operator was chosen deliberately and is consistent with standard binary option settlement conventions. It is visible in the architecture documentation and the frontend displays "Yes wins at or above $X."

### Oracle Staleness at Settlement Time

The settlement instruction requires the oracle price to be no older than 120 seconds (`settlement_staleness` in GlobalConfig). If the oracle feeder goes offline or Tradier's streaming connection drops near market close, the oracle price may be stale when `settle_market` is called.

In this case, `settle_market` rejects the transaction with a staleness error. The settlement scheduler will retry. If the oracle does not recover within 1 hour of market close, the admin can call `admin_settle` with a manually entered closing price obtained from a public source. The 120-second threshold is configurable in GlobalConfig without redeployment.

### Override Window Interaction With Crank Cancel

During the 1-hour settlement override window, winner/loser redemptions are blocked to prevent payouts on a potentially incorrect outcome. `crank_cancel` is intentionally not blocked — it returns resting order escrow (USDC, Yes tokens, No tokens) to their owners regardless of the outcome. Users get their unmatched order funds back immediately post-settlement. Only the outcome-dependent redemption (winning token → $1) is delayed.

---

## Prototype Disclaimer

Meridian is a devnet prototype built for demonstration and evaluation purposes.

- It does not constitute a regulated financial product, security, or financial instrument.
- No regulatory or compliance claims are made. Binary outcome contracts may be regulated as swaps, prediction contracts, or other instruments depending on jurisdiction. This system has not been evaluated for regulatory compliance.
- The system has not been audited for production use. Audit findings from each development phase have been addressed within the phase, but no independent third-party security audit of the complete system has been conducted.
- All funds in the system are on Solana devnet. Devnet SOL and USDC have no monetary value.
- The mock oracle, admin keypair, and USDC faucet are centralized devnet-only constructs. A production deployment would replace all three with decentralized equivalents (Pyth, multisig, real USDC).
