# HyperLiquid Feasibility Analysis

The spec (lines 56–58) notes: "HyperLiquid is worth considering as an alternative, though it may not natively support this type of custom instrument at this time — research and document feasibility if you explore this path."

This document records the full analysis conducted prior to finalizing the Solana architecture.

---

## What HyperLiquid Is (and Isn't)

HyperLiquid is a purpose-built derivatives exchange disguised as a blockchain. Its L1 is optimized for one thing — matching orders on perpetual futures with sub-millisecond latency, deep liquidity, and zero gas fees for traders. The order book is native to the consensus layer, not a smart contract running on top of a general-purpose chain.

The value proposition is: if your product is a standard derivative that fits their instrument model, you get world-class order book infrastructure for free. No building a CLOB, no worrying about gas per order, no compute budgets.

Meridian is not a standard derivative. It requires custom token pair lifecycle (mint, trade, settle, redeem), a $1 vault invariant, binary discrete settlement, a custom oracle, admin override, crank cleanup, and market closure. All of this requires general-purpose programmability — HyperLiquid gives you a fast exchange, not a programmable computer.

### HyperEVM

HyperLiquid launched HyperEVM in 2025 — an EVM-compatible execution layer running alongside the native L1. This means Solidity contracts can be deployed on HyperLiquid. Whether that helps for Meridian is the question this analysis answers.

---

## Path 1: Pure HyperEVM (Solidity Contracts, Custom CLOB)

Rebuild the entire system in Solidity on HyperEVM. ERC-20 Yes/No tokens, USDC vault, custom CLOB matching engine, oracle contract fed by Tradier, settlement/redemption/admin logic.

**What works:**
- HyperEVM inherits HyperLiquid's sub-second block times and low fees.
- EVM tooling is broadly mature (Hardhat, Foundry, OpenZeppelin).
- Everything Meridian needs can be built in Solidity.

**Technical blockers / costs:**
- **Gas per order**: Every `place_order` writes storage slots; every fill writes more. A single order with 3 fills could cost 200k–500k gas. HyperEVM gas is cheap compared to Ethereum mainnet, but the compute overhead is real and compounds with book depth.
- **No ZeroCopy equivalent**: Meridian's ~126KB OrderBook works on Solana because ZeroCopy memory-maps the account directly. In Solidity, 99 price levels × 16 slots would use mappings and arrays with a different gas profile and more expensive iteration.
- **100% rewrite**: Anchor → Hardhat/Foundry. Rust → Solidity. All PDA derivation patterns become CREATE2 deterministic addresses. ATAs become ERC-20 `approve`/`transferFrom` flows. The bankrun test suite becomes Foundry tests with `vm.warp()`. Every line of existing Phase 1–3 code is discarded.
- **No advantage over Solana**: You would be building the same system in a different language with worse on-chain CLOB economics and no access to HyperLiquid's native order book (which is the chain's core value proposition). Using HyperEVM as a generic EVM chain means any other L2 (Arbitrum, Base) would serve equally well.

**Verdict**: Technically feasible. Strategically pointless. Full rewrite for no gain.

---

## Path 2: HyperEVM Contracts + HyperLiquid Native Spot Book

Use HyperEVM for minting, settlement, and redemption logic, but list Yes/No tokens on HyperLiquid's native spot order book — which is high-performance, zero gas, and already built.

**What this would require:**
- Deploy mint/vault/settlement contracts on HyperEVM.
- Get Yes/No tokens listed as native spot trading pairs on HyperLiquid's order book.
- Users trade on the native book (fast, cheap, no gas per order).
- Settlement reads from the oracle contract on HyperEVM and signals the native book to halt trading and enable redemption.

**Technical blockers:**
- **Permissioned listing**: HyperLiquid does not support permissionless self-service listing of arbitrary spot tokens on the native book. Listing requires going through their governance process. For a prototype with a submission deadline, timeline is uncontrollable — this is a non-starter.
- **Cross-layer communication gaps**: The HyperEVM settlement contract needs to read native L1 book state (positions, open orders) and halt trading at settlement time. The HyperEVM ↔ L1 bridge exists, but the interface for custom instruments reading native book state is not well-documented and may not support the access patterns Meridian needs.
- **No custom settlement logic on the native book**: The native book handles standard spot settlement (token A for token B). Binary outcome settlement — read oracle, mark contract as $1 or $0, block further trading, enable redemption — is custom state machine logic that the native engine does not expose.

**Verdict**: The best architecture conceptually, if HyperLiquid supported it. Blocked on permissioned listing and missing cross-layer hooks. Not viable for a prototype.

---

## Path 3: Map Binary Outcomes to HyperLiquid Perps

Instead of custom tokens, create a perpetual futures contract that trades between $0 and $1, settling at 4 PM ET.

**Why this fails:**
- **Perps do not expire**: HyperLiquid perps settle continuously via funding rates, not discretely at a point in time. A 0DTE binary that resolves at exactly 4 PM ET is a fundamentally different instrument — a perp has no equivalent concept of discrete settlement.
- **Same listing bottleneck**: Custom perps also require HyperLiquid governance approval. Same timeline problem as Path 2.
- **No $1 invariant**: The Yes + No = $1 relationship does not map to a perp's P&L structure. A perp tracks price continuously; a binary outcome is discontinuous — probability approaches $1 or $0 and then resolves exactly. There is no financial mapping that makes these equivalent.
- **No mint/redeem model**: Perps are margin-based. Users do not deposit $1 to mint complementary tokens. The entire economic model is incompatible.

**Verdict**: Square peg, round hole. The instrument types are fundamentally incompatible.

---

## Comparison Matrix

| Criterion | Solana (chosen) | HyperEVM Path 1 | HyperEVM + Native Book Path 2 | Native Perps Path 3 |
|---|---|---|---|---|
| Feasible for prototype? | Yes | Yes (full rewrite) | No (permissioned listing) | No (wrong instrument) |
| CLOB performance | Excellent (ZeroCopy, flat CU) | Adequate (gas overhead) | Excellent (native book) | N/A |
| Rewrite scope | N/A | 100% | ~60% | N/A |
| External dependencies | None | None | HyperLiquid listing approval | HyperLiquid listing approval |
| Spec compliance | Full | Full (if rebuilt) | Partial | No |
| Custom instrument support | Full | Full | Partial (listing gated) | None |

---

## Conclusion

HyperLiquid's core value proposition — best-in-class order book infrastructure — only applies if your product fits their native instrument model. Meridian does not fit: it requires custom token minting, a vault invariant, discrete binary settlement, and a custom oracle. None of that is available through HyperLiquid's native book or native perps engine.

The only technically viable path (Path 1, pure HyperEVM) amounts to using HyperLiquid as a generic EVM chain while ignoring its core strength. At that point, any EVM L2 would serve equally well, and you still get worse on-chain CLOB economics than Solana's ZeroCopy / flat compute model.

Solana's programming model — Anchor, ZeroCopy, flat compute pricing, SPL tokens, bankrun testing — is purpose-built for exactly the kind of on-chain application Meridian requires.

**When HyperLiquid would be the right choice**: If Meridian were a perpetual futures product (continuous binary funding contract rather than 0DTE discrete settlement), or if HyperLiquid opened permissionless spot listings with custom settlement hooks, the calculus would change. Neither condition holds today.
