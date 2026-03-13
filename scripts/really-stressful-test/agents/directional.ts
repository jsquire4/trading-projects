/**
 * directional.ts — Directional trader agent that takes bullish or bearish
 * positions. Occasionally exits by placing opposing orders.
 */

import { Transaction } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import BN from "bn.js";
import { BaseAgent } from "./base-agent";
import type { MarketContext } from "../types";
import { buildMintPairIx, buildPlaceOrderIx } from "../../../tests/helpers/instructions";
import { parseOrderBook } from "../../stress-test/helpers";
import { DEFAULT_MINT_QUANTITY, MAX_FILLS } from "../config";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Directional
// ---------------------------------------------------------------------------

export class Directional extends BaseAgent {
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

      const bullish = this.state.rng.next() > 0.5;

      if (bullish) {
        // Buy Yes: crossing bid against resting asks
        // Read fresh orderbook to find resting asks
        const obAcct = await this.ctx.connection.getAccountInfo(m.orderBook);
        if (!obAcct) return;

        const orders = parseOrderBook(Buffer.from(obAcct.data));
        const asks = orders.filter((o) => o.side === 1 && o.isActive);

        // Build maker accounts: each ask maker's USDC ATA
        const makerAccounts = asks.slice(0, MAX_FILLS).map((ask) =>
          getAssociatedTokenAddressSync(this.ctx.usdcMint, ask.owner),
        );

        const price = Math.min(99, Math.floor(55 + this.state.rng.next() * 20));

        const bidIx = buildPlaceOrderIx({
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
          price,
          quantity: new BN(1_000_000),
          orderType: 1,        // Limit
          maxFills: MAX_FILLS,
          makerAccounts,
        });

        const bidTx = new Transaction().add(bidIx);
        await this.sendTimed(bidTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      } else {
        // Bearish: Buy No via Sell No (side=2) — needs No tokens
        let noBalance = 0n;
        try {
          const acct = await getAccount(this.ctx.connection, noAtaAddr);
          noBalance = acct.amount;
        } catch {
          noBalance = 0n;
        }

        if (noBalance === 0n) {
          // Mint pairs first to get No tokens
          const mintIx = buildMintPairIx({
            user: this.keypair.publicKey,
            config: this.ctx.configPda,
            market: m.market,
            yesMint: m.yesMint,
            noMint: m.noMint,
            userUsdcAta: usdcAtaAddr,
            userYesAta: yesAtaAddr,
            userNoAta: noAtaAddr,
            usdcVault: m.usdcVault,
            quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
          });

          const mintTx = new Transaction().add(mintIx);
          const sig = await this.sendTimed(mintTx, [this.keypair], "mint_pair");
          if (!sig) return;
        }

        const price = Math.max(1, Math.floor(25 + this.state.rng.next() * 20));

        const sellNoIx = buildPlaceOrderIx({
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
          side: 2,             // No-backed bid (Sell No)
          price,
          quantity: new BN(1_000_000),
          orderType: 1,        // Limit
          maxFills: 0,         // Resting
        });

        const sellTx = new Transaction().add(sellNoIx);
        await this.sendTimed(sellTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }

      // 20% chance: try to exit — if holding Yes tokens, sell them
      if (this.state.rng.next() < 0.2) {
        let yesBalance = 0n;
        try {
          const acct = await getAccount(this.ctx.connection, yesAtaAddr);
          yesBalance = acct.amount;
        } catch {
          yesBalance = 0n;
        }

        if (yesBalance > 0n) {
          // Read fresh orderbook to find bids
          const obAcct = await this.ctx.connection.getAccountInfo(m.orderBook);
          if (obAcct) {
            const orders = parseOrderBook(Buffer.from(obAcct.data));
            const bids = orders.filter((o) => o.side === 0 && o.isActive);

            const makerAccounts = bids.slice(0, MAX_FILLS).map((bid) =>
              getAssociatedTokenAddressSync(this.ctx.usdcMint, bid.owner),
            );

            const exitIx = buildPlaceOrderIx({
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
              side: 1,           // Yes ask (Sell Yes)
              price: Math.max(1, Math.floor(30 + this.state.rng.next() * 30)),
              quantity: new BN(1_000_000),
              orderType: 1,
              maxFills: MAX_FILLS,
              makerAccounts,
            });

            const exitTx = new Transaction().add(exitIx);
            await this.sendTimed(exitTx, [this.keypair], "place_order");
            this.state.ordersPlaced++;
          }
        }
      }
    } catch (e: unknown) {
      this.recordError("directional_act", e);
    }
  }
}
