// ---------------------------------------------------------------------------
// Close Market logic — reclaims rent from settled markets after 90 days
// ---------------------------------------------------------------------------

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig, findTreasury } from "../../shared/src/pda.js";
import { MarketInfo, tickerFromBytes } from "./settler.js";

const log = createLogger("settlement:closer");

const CLOSE_ELIGIBILITY_DAYS = 90;
const CLOSE_ELIGIBILITY_S = CLOSE_ELIGIBILITY_DAYS * 24 * 60 * 60;

/**
 * Check if the order book is empty (all level counts == 0).
 */
function isOrderBookEmpty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderBookAccount: any,
): boolean {
  for (const level of orderBookAccount.levels) {
    for (const slot of level.orders) {
      const active = typeof slot.isActive === "number" ? slot.isActive : Number(slot.isActive);
      if (active === 1) return false;
    }
  }
  return true;
}

/**
 * Close all eligible markets that are:
 *   - settled && !closed
 *   - past the override deadline
 *   - either: (a) all tokens redeemed (standard close), or
 *             (b) 90+ days since settlement (partial close)
 */
export async function closeEligibleMarkets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  adminKeypair: Keypair,
  connection: Connection,
): Promise<{ closed: string[]; failed: { market: string; error: string }[] }> {
  const now = Math.floor(Date.now() / 1000);
  const [configPda] = findGlobalConfig();
  const [treasuryPda] = findTreasury();

  log.info("Scanning for closeable markets");

  const allMarkets = await program.account.strikeMarket.all();

  // Filter candidates: settled, not closed, past override deadline
  const candidates = allMarkets.filter((m) => {
    const isSettled = m.account.isSettled as boolean;
    const isClosed = m.account.isClosed as boolean;
    const overrideDeadline = (m.account.overrideDeadline as BN).toNumber();
    return isSettled && !isClosed && overrideDeadline > 0 && overrideDeadline < now;
  });

  log.info(`Found ${candidates.length} settled, unclosed markets past override deadline`);

  const result: { closed: string[]; failed: { market: string; error: string }[] } = {
    closed: [],
    failed: [],
  };

  for (const m of candidates) {
    const ticker = tickerFromBytes(m.account.ticker as number[]);
    const settledAt = (m.account.settledAt as BN).toNumber();
    const market: MarketInfo = {
      publicKey: m.publicKey,
      account: {
        config: m.account.config as PublicKey,
        ticker: m.account.ticker as number[],
        strikePrice: m.account.strikePrice as BN,
        marketCloseUnix: m.account.marketCloseUnix as BN,
        isSettled: m.account.isSettled as boolean,
        oracleFeed: m.account.oracleFeed as PublicKey,
        orderBook: m.account.orderBook as PublicKey,
        escrowVault: m.account.escrowVault as PublicKey,
        yesEscrow: m.account.yesEscrow as PublicKey,
        noEscrow: m.account.noEscrow as PublicKey,
        yesMint: m.account.yesMint as PublicKey,
        noMint: m.account.noMint as PublicKey,
        usdcVault: m.account.usdcVault as PublicKey,
      },
    };

    try {
      // Check order book is empty
      const orderBookAccount = await program.account.orderBook.fetch(market.account.orderBook);
      if (!isOrderBookEmpty(orderBookAccount)) {
        log.warn(`Order book not empty for ${ticker} — run crank cancel first`, {
          market: m.publicKey.toBase58(),
        });
        continue;
      }

      // Check token supply — standard close requires all tokens redeemed
      const yesMintInfo = await getMint(connection, market.account.yesMint);
      const noMintInfo = await getMint(connection, market.account.noMint);
      const allRedeemed = yesMintInfo.supply === 0n && noMintInfo.supply === 0n;

      // Partial close: 90+ days since settlement
      const daysSinceSettlement = Math.floor((now - settledAt) / 86400);
      const partialCloseEligible = (settledAt + CLOSE_ELIGIBILITY_S) < now;

      if (!allRedeemed && !partialCloseEligible) {
        log.info(
          `Market ${ticker} has unredeemed tokens and only ${daysSinceSettlement} days since settlement (need ${CLOSE_ELIGIBILITY_DAYS})`,
          { market: m.publicKey.toBase58() },
        );
        continue;
      }

      const closeType = allRedeemed ? "standard" : "partial";
      log.info(`Closing market ${ticker} (${closeType}, ${daysSinceSettlement} days since settlement)`, {
        market: m.publicKey.toBase58(),
        yesSupply: yesMintInfo.supply.toString(),
        noSupply: noMintInfo.supply.toString(),
      });

      await program.methods
        .closeMarket()
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          market: m.publicKey,
          orderBook: market.account.orderBook,
          usdcVault: market.account.usdcVault,
          escrowVault: market.account.escrowVault,
          yesEscrow: market.account.yesEscrow,
          noEscrow: market.account.noEscrow,
          yesMint: market.account.yesMint,
          noMint: market.account.noMint,
          treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: new PublicKey("11111111111111111111111111111111"),
        })
        .rpc();

      log.info(`Market ${ticker} closed successfully (${closeType})`, {
        market: m.publicKey.toBase58(),
      });
      result.closed.push(ticker);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to close market ${ticker}: ${errMsg}`, {
        market: m.publicKey.toBase58(),
      });
      result.failed.push({ market: ticker, error: errMsg });
    }
  }

  log.info(`Close cycle complete: ${result.closed.length} closed, ${result.failed.length} failed`);
  return result;
}
