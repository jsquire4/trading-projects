// ---------------------------------------------------------------------------
// Close Market logic — reclaims rent from settled markets
// Standard close only: all tokens must be redeemed (no partial close)
// ---------------------------------------------------------------------------

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createLogger } from "../../shared/src/alerting.js";
import { findGlobalConfig, findTreasury, findSolTreasury } from "../../shared/src/pda.js";
import { MarketInfo, tickerFromBytes } from "./settler.js";

const log = createLogger("settlement:closer");

/**
 * Close all eligible markets that are:
 *   - settled
 *   - past the override deadline
 *   - all tokens redeemed (yes + no supply == 0)
 *   - order book empty
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
  const [solTreasuryPda] = findSolTreasury();

  log.info("Scanning for closeable markets");

  const allMarkets = await program.account.strikeMarket.all();

  // Filter candidates: settled, past override deadline
  const candidates = allMarkets.filter((m) => {
    const isSettled = m.account.isSettled as boolean;
    const overrideDeadline = (m.account.overrideDeadline as BN).toNumber();
    return isSettled && overrideDeadline > 0 && overrideDeadline < now;
  });

  log.info(`Found ${candidates.length} settled markets past override deadline`);

  const result: { closed: string[]; failed: { market: string; error: string }[] } = {
    closed: [],
    failed: [],
  };

  for (const m of candidates) {
    const ticker = tickerFromBytes(m.account.ticker as number[]);
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
      // Check token supply — standard close requires all tokens redeemed
      const yesMintInfo = await getMint(connection, market.account.yesMint);
      const noMintInfo = await getMint(connection, market.account.noMint);
      const allRedeemed = yesMintInfo.supply === 0n && noMintInfo.supply === 0n;

      if (!allRedeemed) {
        log.info(`Market ${ticker} has unredeemed tokens — skipping close`, {
          market: m.publicKey.toBase58(),
          yesSupply: yesMintInfo.supply.toString(),
          noSupply: noMintInfo.supply.toString(),
        });
        continue;
      }

      log.info(`Closing market ${ticker}`, { market: m.publicKey.toBase58() });

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
          solTreasury: solTreasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: new PublicKey("11111111111111111111111111111111"),
        })
        .rpc();

      log.info(`Market ${ticker} closed successfully`, { market: m.publicKey.toBase58() });
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
