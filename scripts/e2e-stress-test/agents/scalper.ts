/**
 * scalper.ts — Fast-trading agent that crosses the spread and immediately
 * re-lists for a small profit. Exercises the merge path via No-backed bids.
 */

import { Transaction } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { BaseAgent } from "./base-agent";
import type { MarketContext } from "../types";
import { buildMintPairIx, buildPlaceOrderIx } from "../../../tests/helpers/instructions";
import { parseOrderBook } from "../helpers";
import { DEFAULT_MINT_QUANTITY, MAX_FILLS } from "../config";

// ---------------------------------------------------------------------------
// Scalper
// ---------------------------------------------------------------------------

export class Scalper extends BaseAgent {
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
        this.ctx.connection,
        this.keypair,
        m.yesMint,
        this.keypair.publicKey,
      );
      await getOrCreateAssociatedTokenAccount(
        this.ctx.connection,
        this.keypair,
        m.noMint,
        this.keypair.publicKey,
      );

      // Read fresh orderbook
      const obAcct = await this.ctx.connection.getAccountInfo(m.orderBook);
      if (!obAcct) return;

      const orders = parseOrderBook(Buffer.from(obAcct.data));
      const asks = orders
        .filter((o) => o.side === 1 && o.isActive)
        .sort((a, b) => a.priceLevel - b.priceLevel);

      // Step 1: Find best ask, place crossing bid 1c above
      if (asks.length > 0) {
        const bestAskPrice = asks[0].priceLevel;
        const crossPrice = Math.min(99, bestAskPrice + 1);

        // Build maker accounts for crossing fills (sequential — fresh read already done)
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
          side: 0,             // USDC bid (Buy Yes)
          price: crossPrice,
          quantity: new BN(1_000_000),
          orderType: 1,        // Limit
          maxFills: MAX_FILLS,
          makerAccounts,
        });

        const crossTx = new Transaction().add(crossIx);
        await this.sendTimed(crossTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;

        // Step 3: If we got Yes tokens from the fill, immediately re-list 2c above
        let yesBalance = 0n;
        try {
          const acct = await getAccount(this.ctx.connection, yesAtaAddr);
          yesBalance = acct.amount;
        } catch {
          yesBalance = 0n;
        }

        if (yesBalance > 0n) {
          const relistPrice = Math.min(99, bestAskPrice + 2);

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
            side: 1,           // Yes ask (Sell Yes) — resting
            price: relistPrice,
            quantity: new BN(1_000_000),
            orderType: 1,
            maxFills: 0,       // Resting only
          });

          const relistTx = new Transaction().add(relistIx);
          await this.sendTimed(relistTx, [this.keypair], "place_order");
          this.state.ordersPlaced++;
        }
      }

      // Step 2: If we hold No tokens, exercise the merge path
      let noBalance = 0n;
      try {
        const acct = await getAccount(this.ctx.connection, noAtaAddr);
        noBalance = acct.amount;
      } catch {
        noBalance = 0n;
      }

      if (noBalance > 0n && asks.length > 0) {
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
          side: 2,             // No-backed bid (Sell No) — exercises merge path
          price: mergePrice,
          quantity: new BN(1_000_000),
          orderType: 1,
          maxFills: 0,         // Resting
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
