/**
 * strike-creator.ts — Agent that creates new strike markets during the test.
 * Only fires ~10% of the time. Handles the full creation flow: allocate
 * orderbook, create market, ALT warmup + create + extend + set, then seed
 * liquidity with a mint_pair.
 */

import {
  Keypair,
  Transaction,
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import BN from "bn.js";
import { BaseAgent } from "./base-agent";
import type { MarketContext } from "../types";
import {
  buildAllocateOrderBookIx,
  buildCreateStrikeMarketIx,
  buildSetMarketAltIx,
  buildMintPairIx,
  padTicker,
} from "../../../tests/helpers/instructions";
import {
  findStrikeMarket,
  findYesMint,
  findNoMint,
  findUsdcVault,
  findEscrowVault,
  findYesEscrow,
  findNoEscrow,
  findOrderBook,
  findPriceFeed,
} from "../../../services/shared/src/pda";
import {
  ALLOC_CALLS_REQUIRED,
  ALLOC_BATCH_SIZE,
  ALT_WARMUP_SLEEP_MS,
  DEFAULT_MINT_QUANTITY,
} from "../config";
import { sendTx, batch } from "../../stress-test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// StrikeCreator
// ---------------------------------------------------------------------------

export class StrikeCreator extends BaseAgent {
  async act(markets: MarketContext[], oraclePrices: Map<string, bigint>): Promise<void> {
    try {
      // Only runs ~10% of the time
      if (this.state.rng.next() >= 0.1) return;
      if (markets.length === 0) return;

      // Pick a ticker from the config
      const tickers = this.ctx.config.tickers;
      const ticker = tickers[Math.floor(this.state.rng.next() * tickers.length)];

      // Compute strike from oracle price +/-10%, rounded to nearest $10
      const oraclePrice = oraclePrices.get(ticker);
      if (!oraclePrice) return;

      const oracleDollars = Number(oraclePrice) / 1_000_000;
      const offset = (this.state.rng.next() - 0.5) * 0.2 * oracleDollars; // ±10%
      const rawStrike = oracleDollars + offset;
      const roundedStrike = Math.round(rawStrike / 10) * 10;
      const strikeLamports = BigInt(roundedStrike) * 1_000_000n; // $10 = 10_000_000 lamports

      // Use marketCloseUnix from the latest existing market
      const latestMarket = markets[markets.length - 1];
      const marketCloseUnix = latestMarket.marketCloseUnix;

      // Derive market PDA
      const [market] = findStrikeMarket(ticker, strikeLamports, marketCloseUnix);

      // Check if market already exists — skip if so
      const existing = await this.ctx.connection.getAccountInfo(market);
      if (existing) return;

      // Derive all PDAs
      const [yesMint] = findYesMint(market);
      const [noMint] = findNoMint(market);
      const [usdcVault] = findUsdcVault(market);
      const [escrowVault] = findEscrowVault(market);
      const [yesEscrow] = findYesEscrow(market);
      const [noEscrow] = findNoEscrow(market);
      const [orderBook] = findOrderBook(market);
      const [oracleFeed] = findPriceFeed(ticker);

      const admin = this.ctx.admin;

      // ── Step 1: Allocate OrderBook (13 calls, batched 6/tx) ──────────────
      const allocIxs = [];
      for (let i = 0; i < ALLOC_CALLS_REQUIRED; i++) {
        allocIxs.push(
          buildAllocateOrderBookIx({
            payer: admin.publicKey,
            orderBook,
            marketKey: market,
          }),
        );
      }

      const allocBatches = batch(allocIxs, ALLOC_BATCH_SIZE);
      for (const ixBatch of allocBatches) {
        const tx = new Transaction();
        for (const ix of ixBatch) {
          tx.add(ix);
        }
        const sig = await this.sendTimed(tx, [admin], "allocate_order_book");
        if (!sig) return;
      }

      // ── Step 2: Create Strike Market ─────────────────────────────────────
      const expiryDay = Math.floor(marketCloseUnix / 86400);
      const previousCloseLamports = oraclePrice; // use current price as previous close

      const createIx = buildCreateStrikeMarketIx({
        admin: admin.publicKey,
        config: this.ctx.configPda,
        market,
        yesMint,
        noMint,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        orderBook,
        oracleFeed,
        usdcMint: this.ctx.usdcMint,
        creatorUsdcAta: getAssociatedTokenAddressSync(this.ctx.usdcMint, admin.publicKey),
        feeVault: this.ctx.feeVault,
        ticker: padTicker(ticker),
        strikePrice: new BN(strikeLamports.toString()),
        expiryDay,
        marketCloseUnix: new BN(marketCloseUnix),
        previousClose: new BN(previousCloseLamports.toString()),
      });

      const createTx = new Transaction().add(createIx);
      const createSig = await this.sendTimed(createTx, [admin], "create_strike_market");
      if (!createSig) return;

      // ── Step 3: ALT warmup + create + extend + sleep + setMarketAlt ──────
      // Warmup: self-transfer 1 lamport to advance slot
      const warmupIx = SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: admin.publicKey,
        lamports: 1,
      });
      const warmupTx = new Transaction().add(warmupIx);
      await sendTx(this.ctx.connection, warmupTx, [admin], { skipPreflight: true });

      const slot = await this.ctx.connection.getSlot("confirmed");

      // Create ALT
      const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: admin.publicKey,
        payer: admin.publicKey,
        recentSlot: slot,
      });

      const createAltTx = new Transaction().add(createAltIx);
      await sendTx(this.ctx.connection, createAltTx, [admin], { skipPreflight: true });

      // Extend ALT with market addresses
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        lookupTable: altAddress,
        authority: admin.publicKey,
        payer: admin.publicKey,
        addresses: [
          market,
          yesMint,
          noMint,
          usdcVault,
          escrowVault,
          yesEscrow,
          noEscrow,
          orderBook,
          oracleFeed,
        ],
      });

      const extendTx = new Transaction().add(extendIx);
      await sendTx(this.ctx.connection, extendTx, [admin], { skipPreflight: true });

      // Wait for ALT to warm up
      await sleep(ALT_WARMUP_SLEEP_MS);

      // Set market ALT
      const setAltIx = buildSetMarketAltIx({
        admin: admin.publicKey,
        config: this.ctx.configPda,
        market,
        altAddress,
      });

      const setAltTx = new Transaction().add(setAltIx);
      await this.sendTimed(setAltTx, [admin], "set_market_alt");

      // ── Step 4: Push new MarketContext ────────────────────────────────────
      const newMarket: MarketContext = {
        ticker,
        strikeLamports,
        previousCloseLamports: BigInt(previousCloseLamports.toString()),
        marketCloseUnix,
        market,
        yesMint,
        noMint,
        usdcVault,
        escrowVault,
        yesEscrow,
        noEscrow,
        orderBook,
        oracleFeed: oracleFeed,
        altAddress,
        day: latestMarket.day,
      };

      this.ctx.markets.push(newMarket);

      // ── Step 5: Mint to seed liquidity ───────────────────────────────────
      // Create ATAs for the creator agent
      await getOrCreateAssociatedTokenAccount(
        this.ctx.connection,
        this.keypair,
        yesMint,
        this.keypair.publicKey,
      );
      await getOrCreateAssociatedTokenAccount(
        this.ctx.connection,
        this.keypair,
        noMint,
        this.keypair.publicKey,
      );

      const mintIx = buildMintPairIx({
        user: this.keypair.publicKey,
        config: this.ctx.configPda,
        market,
        yesMint,
        noMint,
        userUsdcAta: this.usdcAta(),
        userYesAta: getAssociatedTokenAddressSync(yesMint, this.keypair.publicKey),
        userNoAta: getAssociatedTokenAddressSync(noMint, this.keypair.publicKey),
        usdcVault,
        quantity: new BN(DEFAULT_MINT_QUANTITY.toString()),
      });

      const mintTx = new Transaction().add(mintIx);
      await this.sendTimed(mintTx, [this.keypair], "mint_pair");
    } catch (e: unknown) {
      this.recordError("strike_creator_act", e);
    }
  }
}
