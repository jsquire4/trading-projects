/**
 * market-maker.ts — Posts resting limit orders on both sides of the book.
 *
 * ConflictingPosition constraints:
 *   side=0 (USDC bid): requires no_ata == 0
 *   side=1 (Yes ask):  no constraint
 *   side=2 (No bid):   requires yes_ata == 0
 *
 * Strategy: Mint pairs → post Yes asks first (side=1, escrows Yes → yes_ata=0)
 * → then post No bids (side=2, now yes_ata=0). Never use side=0 after minting.
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

      // Check current balances
      let yesBalance = 0n;
      let noBalance = 0n;
      try { yesBalance = (await getAccount(this.ctx.connection, yesAtaAddr)).amount; } catch {}
      try { noBalance = (await getAccount(this.ctx.connection, noAtaAddr)).amount; } catch {}

      // Mint if we have no tokens (mint_pair requires yes_ata == 0)
      if (yesBalance === 0n && noBalance === 0n) {
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

        // After minting: yesBalance > 0, noBalance > 0
        try { yesBalance = (await getAccount(this.ctx.connection, yesAtaAddr)).amount; } catch {}
        try { noBalance = (await getAccount(this.ctx.connection, noAtaAddr)).amount; } catch {}
      }

      // Generate a random mid price in the 40-60c range
      const mid = Math.floor(this.state.rng.next() * 20 + 40);

      // Post asks FIRST (side=1, no constraint) — escrows Yes tokens
      if (yesBalance > 0n) {
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
            userUsdcAta: usdcAtaAddr,
            userYesAta: yesAtaAddr,
            userNoAta: noAtaAddr,
            feeVault: this.ctx.feeVault,
            side: 1,       // Yes ask — no constraint
            price,
            quantity: new BN(1_000_000),
            orderType: 1,
            maxFills: 0,   // Resting only
          });

          const askTx = new Transaction().add(askIx);
          await this.sendTimed(askTx, [this.keypair], "place_order");
          this.state.ordersPlaced++;
        }
      }

      // Re-check yes balance after asks (should be 0 or near 0 after escrowing)
      try { yesBalance = (await getAccount(this.ctx.connection, yesAtaAddr)).amount; } catch { yesBalance = 0n; }

      // Post No-backed bids (side=2, requires yes_ata == 0)
      if (noBalance > 0n && yesBalance === 0n) {
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
            userUsdcAta: usdcAtaAddr,
            userYesAta: yesAtaAddr,
            userNoAta: noAtaAddr,
            feeVault: this.ctx.feeVault,
            side: 2,       // No-backed bid — requires yes_ata == 0
            price,
            quantity: new BN(1_000_000),
            orderType: 1,
            maxFills: 0,   // Resting only
          });

          const bidTx = new Transaction().add(bidIx);
          await this.sendTimed(bidTx, [this.keypair], "place_order");
          this.state.ordersPlaced++;
        }
      } else if (yesBalance === 0n && noBalance === 0n) {
        // No tokens left — place pure USDC bids (side=0, requires no_ata == 0)
        // Safe: both token balances are 0
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
            userUsdcAta: usdcAtaAddr,
            userYesAta: yesAtaAddr,
            userNoAta: noAtaAddr,
            feeVault: this.ctx.feeVault,
            side: 0,       // USDC bid — requires no_ata == 0
            price,
            quantity: new BN(1_000_000),
            orderType: 1,
            maxFills: 0,
          });

          const bidTx = new Transaction().add(bidIx);
          await this.sendTimed(bidTx, [this.keypair], "place_order");
          this.state.ordersPlaced++;
        }
      }
    } catch (e: unknown) {
      this.recordError("market_maker_act", e);
    }
  }
}
