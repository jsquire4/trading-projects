/**
 * scalper.ts — Fast-trading agent that crosses the spread and immediately
 * re-lists for a small profit. Exercises the merge path via No-backed bids.
 *
 * ConflictingPosition constraints:
 *   side=0 (USDC bid): requires no_ata == 0
 *   side=1 (Yes ask):  no constraint
 *   side=2 (No bid):   requires yes_ata == 0
 *
 * Strategy: Check balances before every order to avoid ConflictingPosition.
 * - side=0 only if no_ata == 0
 * - side=2 only if yes_ata == 0
 * - side=1 always safe
 */

import { Transaction } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { BaseAgent } from "./base-agent";
import type { MarketContext } from "../types";
import { buildPlaceOrderIx } from "../../../tests/helpers/instructions";
import { parseOrderBook } from "../helpers";
import { MAX_FILLS } from "../config";

// ---------------------------------------------------------------------------
// Scalper
// ---------------------------------------------------------------------------

export class Scalper extends BaseAgent {
  private async getBalance(ata: import("@solana/web3.js").PublicKey): Promise<bigint> {
    try { return (await getAccount(this.ctx.connection, ata)).amount; } catch { return 0n; }
  }

  async act(markets: MarketContext[]): Promise<void> {
    try {
      if (markets.length === 0) return;

      // Pick a random market
      const mIdx = Math.floor(this.state.rng.next() * markets.length);
      const m = markets[mIdx];

      const yesAtaAddr = this.yesAta(m.yesMint);
      const noAtaAddr = this.noAta(m.noMint);
      const usdcAtaAddr = this.usdcAta();

      // Ensure ATAs exist
      await getOrCreateAssociatedTokenAccount(
        this.ctx.connection, this.keypair, m.yesMint, this.keypair.publicKey,
      );
      await getOrCreateAssociatedTokenAccount(
        this.ctx.connection, this.keypair, m.noMint, this.keypair.publicKey,
      );

      // Read fresh orderbook
      const obAcct = await this.ctx.connection.getAccountInfo(m.orderBook);
      if (!obAcct) return;

      const orders = parseOrderBook(Buffer.from(obAcct.data));
      const asks = orders
        .filter((o) => o.side === 1 && o.isActive)
        .sort((a, b) => a.priceLevel - b.priceLevel);

      // Step 1: Cross the spread — buy Yes via side=0 if eligible
      let noBalance = await this.getBalance(noAtaAddr);

      if (asks.length > 0 && noBalance === 0n) {
        // side=0 requires no_ata == 0 ✓
        const bestAskPrice = asks[0].priceLevel;
        const crossPrice = Math.min(99, bestAskPrice + 1);

        const makerAccounts = asks.slice(0, MAX_FILLS).map((ask) =>
          getAssociatedTokenAddressSync(this.ctx.usdcMint, ask.owner),
        );

        const crossIx = buildPlaceOrderIx({
          user: this.keypair.publicKey,
          config: this.ctx.configPda,
          market: m.market,
          orderBook: m.orderBook,
          usdcVault: m.usdcVault,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          yesMint: m.yesMint,
          noMint: m.noMint,
          userUsdcAta: usdcAtaAddr,
          userYesAta: yesAtaAddr,
          userNoAta: noAtaAddr,
          feeVault: this.ctx.feeVault,
          side: 0,
          price: crossPrice,
          quantity: new BN(1_000_000),
          orderType: 1,
          maxFills: MAX_FILLS,
          makerAccounts,
        });

        const crossTx = new Transaction().add(crossIx);
        await this.sendTimed(crossTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }

      // Step 2: If holding Yes tokens, re-list higher via side=1 (no constraint)
      const yesBalance = await this.getBalance(yesAtaAddr);

      if (yesBalance > 0n && asks.length > 0) {
        const relistPrice = Math.min(99, asks[0].priceLevel + 2);

        const relistIx = buildPlaceOrderIx({
          user: this.keypair.publicKey,
          config: this.ctx.configPda,
          market: m.market,
          orderBook: m.orderBook,
          usdcVault: m.usdcVault,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          yesMint: m.yesMint,
          noMint: m.noMint,
          userUsdcAta: usdcAtaAddr,
          userYesAta: yesAtaAddr,
          userNoAta: noAtaAddr,
          feeVault: this.ctx.feeVault,
          side: 1,           // Yes ask — no constraint
          price: relistPrice,
          quantity: new BN(Math.min(Number(yesBalance), 1_000_000).toString()),
          orderType: 1,
          maxFills: 0,
        });

        const relistTx = new Transaction().add(relistIx);
        await this.sendTimed(relistTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }

      // Step 3: If holding No tokens, exercise merge path via side=2
      noBalance = await this.getBalance(noAtaAddr);
      const yesAfterRelist = await this.getBalance(yesAtaAddr);

      if (noBalance > 0n && yesAfterRelist === 0n && asks.length > 0) {
        // side=2 requires yes_ata == 0 ✓
        const mergePrice = Math.max(1, asks[0].priceLevel - 5);

        const mergeIx = buildPlaceOrderIx({
          user: this.keypair.publicKey,
          config: this.ctx.configPda,
          market: m.market,
          orderBook: m.orderBook,
          usdcVault: m.usdcVault,
          escrowVault: m.escrowVault,
          yesEscrow: m.yesEscrow,
          noEscrow: m.noEscrow,
          yesMint: m.yesMint,
          noMint: m.noMint,
          userUsdcAta: usdcAtaAddr,
          userYesAta: yesAtaAddr,
          userNoAta: noAtaAddr,
          feeVault: this.ctx.feeVault,
          side: 2,             // No-backed bid — requires yes_ata == 0
          price: mergePrice,
          quantity: new BN(Math.min(Number(noBalance), 1_000_000).toString()),
          orderType: 1,
          maxFills: 0,
        });

        const mergeTx = new Transaction().add(mergeIx);
        await this.sendTimed(mergeTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }
    } catch (e: unknown) {
      this.recordError("scalper_act", e);
    }
  }
}
