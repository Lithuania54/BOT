import { fetchClosedPositions, fetchPositions } from "./api/dataApi";
import { logger } from "./logger";
import { Config, ResolvedTarget, TraderScore } from "./types";
import { StateStore } from "./state";
import { createLimiter } from "./limiter";

export async function computeScores(
  targets: ResolvedTarget[],
  config: Config,
  state: StateStore
): Promise<TraderScore[]> {
  const limit = createLimiter(4);
  const now = Date.now();
  const lookbackMs = config.lookbackDays * 24 * 60 * 60 * 1000;

  const tasks = targets.map((target) =>
    limit(async () => {
      try {
        const closed = await fetchClosedPositions(target.proxyWallet);
        const recent = closed.filter((row) => row.timestampMs >= now - lookbackMs);
        const realizedPnlSum = recent.reduce((sum, row) => sum + row.realizedPnl, 0);
        const totalBoughtSum = recent.reduce((sum, row) => sum + row.totalBought, 0);
        const sample = recent.length;
        const roi = realizedPnlSum / Math.max(1, totalBoughtSum);

        const positions = await fetchPositions(target.proxyWallet);
        const openPnlSum = positions.reduce((sum, row) => sum + (row.cashPnl || 0), 0);

        const eligible = sample >= config.minClosedSample;
        const score = eligible
          ? roi * 100 + realizedPnlSum / 1000 - config.openPnlPenaltyFactor * Math.max(0, -openPnlSum)
          : -1e9;

        const result: TraderScore = {
          proxyWallet: target.proxyWallet,
          displayName: target.displayName,
          roi,
          realizedPnlSum,
          totalBoughtSum,
          sample,
          openPnlSum,
          score,
          eligible,
          timestampMs: now,
        };
        state.saveScore(result);
        return result;
      } catch (err) {
        logger.warn("score computation failed", {
          proxyWallet: target.proxyWallet,
          error: (err as Error).message,
        });
        const fallback: TraderScore = {
          proxyWallet: target.proxyWallet,
          displayName: target.displayName,
          roi: 0,
          realizedPnlSum: 0,
          totalBoughtSum: 0,
          sample: 0,
          openPnlSum: 0,
          score: -1e9,
          eligible: false,
          timestampMs: now,
        };
        state.saveScore(fallback);
        return fallback;
      }
    })
  );

  return Promise.all(tasks);
}
