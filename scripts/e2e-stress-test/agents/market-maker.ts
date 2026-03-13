/**
 * market-maker.ts — Posts resting limit orders on both sides of the book.
 * Places 3 bids and 3 asks around a randomized mid price (40-60c range).
 */

import { Transaction } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import BN from "bn.js";
import { BaseAgent } from "./base-agent";
import type { MarketContext } from "../types";
import { buildMintPairIx, buildPlaceOrderIx } from "../../../tests/helpers/instructions";
import { DEFAULT_MINT_QUANTITY } from "../config";

// ---------------------------------------------------------------------------
// MarketMaker
// ---------------------------------------------------------------------------

export class MarketMaker extends BaseAgent {
  async act(markets: MarketContext[]): Promise<void> {
    try {
      if (markets.length === 0) return;

      // Pick a random market
      const mIdx = Math.floor(this.state.rng.next() * markets.length);
      const m = markets[mIdx];

      // Ensure we have Yes/No tokens — mint if needed
      const yesAtaAddr = this.yesAta(m.yesMint);
      let hasTokens = false;
      try {
        const acct = await getAccount(this.ctx.connection, yesAtaAddr);
        hasTokens = acct.amount > 0n;
      } catch {
        hasTokens = false;
      }

      if (!hasTokens) {
        // Create ATAs if needed
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

        // Mint token pairs
        const mintIx = buildMintPairIx({
          user: this.keypair.publicKey,
          config: this.ctx.configPda,
          market: m.market,
          yesMint: m.yesMint,
          noMint: m.noMint,
          userUsdcAta: this.usdcAta(),
          userYesAta: yesAtaAddr,
          userNoAta: this.noAta(m.noMint),
          usdcVault: m.usdcVault,
          quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
        });

        const mintTx = new Transaction().add(mintIx);
        const sig = await this.sendTimed(mintTx, [this.keypair], "mint_pair");
        if (!sig) return; // mint failed, bail
      }

      // Generate a random mid price in the 40-60c range
      const mid = Math.floor(this.state.rng.next() * 20 + 40);

      // Post 3 bids at mid-2, mid-4, mid-6
      const bidOffsets = [2, 4, 6];
      for (const offset of bidOffsets) {
        const price = Math.max(1, mid - offset);
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
          userUsdcAta: this.usdcAta(),
          userYesAta: yesAtaAddr,
          userNoAta: this.noAta(m.noMint),
          feeVault: this.ctx.feeVault,
          side: 0,       // USDC bid (Buy Yes)
          price,
          quantity: new BN(1_000_000),
          orderType: 1,  // Limit
          maxFills: 0,   // Resting only
        });

        const bidTx = new Transaction().add(bidIx);
        await this.sendTimed(bidTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }

      // Post 3 asks at mid+2, mid+4, mid+6
      const askOffsets = [2, 4, 6];
      for (const offset of askOffsets) {
        const price = Math.min(99, mid + offset);
        const askIx = buildPlaceOrderIx({
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
          userUsdcAta: this.usdcAta(),
          userYesAta: yesAtaAddr,
          userNoAta: this.noAta(m.noMint),
          feeVault: this.ctx.feeVault,
          side: 1,       // Yes ask (Sell Yes)
          price,
          quantity: new BN(1_000_000),
          orderType: 1,  // Limit
          maxFills: 0,   // Resting only
        });

        const askTx = new Transaction().add(askIx);
        await this.sendTimed(askTx, [this.keypair], "place_order");
        this.state.ordersPlaced++;
      }
    } catch (e: unknown) {
      this.recordError("market_maker_act", e);
    }
  }
}
