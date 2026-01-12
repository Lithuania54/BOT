import { loadConfig } from "./config";
import { checkGeoblock } from "./api/geoblock";
import { resolveTargetToProxyWallet } from "./api/gamma";
import { fetchTrades, normalizeTrade } from "./api/dataApi";
import { initClobClients } from "./clob";
import { buildTradeKey, mirrorTrade } from "./mirror";
import { StateStore } from "./state";
import { computeScores } from "./scoring";
import { selectLeaders } from "./selector";
import { LeaderSelection, ResolvedTarget, Trade } from "./types";
import { logger } from "./logger";
import { createLimiter } from "./limiter";

const TRADE_LIMIT = 1000;
const MAX_PAGES = 5;

function shouldCopyTrade(selection: LeaderSelection, trade: Trade): { copy: boolean; weight: number } {
  if (selection.mode === "LEADER") {
    const leader = selection.leader;
    if (!leader) return { copy: false, weight: 0 };
    return { copy: leader.proxyWallet === trade.proxyWallet, weight: 1 };
  }
  const leader = selection.leaders.find((l) => l.proxyWallet === trade.proxyWallet);
  return leader ? { copy: true, weight: leader.weight } : { copy: false, weight: 0 };
}

async function resolveTargets(targets: string[], state: StateStore): Promise<ResolvedTarget[]> {
  const limit = createLimiter(4);
  const tasks = targets.map((target) =>
    limit(async () => {
      const resolved = await resolveTargetToProxyWallet(target, state);
      logger.info("resolved target", { target, proxyWallet: resolved.proxyWallet, displayName: resolved.displayName });
      return resolved;
    })
  );
  return Promise.all(tasks);
}

async function fetchNewTradesForTarget(
  target: ResolvedTarget,
  state: StateStore
): Promise<{ trades: Trade[]; newestTimestamp: number }> {
  const lastSeen = state.getLastSeen(target.proxyWallet);
  if (lastSeen === 0) {
    const now = Date.now();
    state.setLastSeen(target.proxyWallet, now);
    logger.info("initialized lastSeen for trader", { proxyWallet: target.proxyWallet, timestampMs: now });
    return { trades: [], newestTimestamp: now };
  }

  const trades: Trade[] = [];
  let newestTimestamp = lastSeen;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await fetchTrades(target.proxyWallet, TRADE_LIMIT, page * TRADE_LIMIT, false);
    if (!raw.length) break;
    for (const row of raw) {
      const trade = normalizeTrade(row, target.proxyWallet);
      if (!trade) continue;
      if (trade.timestampMs > lastSeen) {
        trades.push(trade);
        newestTimestamp = Math.max(newestTimestamp, trade.timestampMs);
      }
    }
    const oldest = raw[raw.length - 1];
    const oldestTrade = normalizeTrade(oldest, target.proxyWallet);
    if (!oldestTrade || oldestTrade.timestampMs <= lastSeen) break;
    if (raw.length < TRADE_LIMIT) break;
  }

  trades.sort((a, b) => a.timestampMs - b.timestampMs);
  return { trades, newestTimestamp };
}

async function run() {
  const config = loadConfig();
  const state = new StateStore();

  const geo = await checkGeoblock();
  if (geo.blocked) {
    logger.error("geoblocked", { reason: geo.reason || "not eligible" });
    process.exit(1);
  }

  const { publicClient, tradingClient } = await initClobClients(config);

  const resolvedTargets = await resolveTargets(config.targets, state);
  let selection: LeaderSelection = { mode: config.followMode, leaders: [], reason: "not evaluated" };
  const failureReasons = new Map<string, string>();

  async function evaluateSelection() {
    const scores = await computeScores(resolvedTargets, config, state);
    selection = selectLeaders(scores, config, state);
    logger.info("selection updated", {
      mode: selection.mode,
      reason: selection.reason,
      leaders: selection.leaders.map((l) => ({
        proxyWallet: l.proxyWallet,
        displayName: l.displayName,
        score: Number(l.score.toFixed(4)),
        weight: Number(l.weight.toFixed(4)),
      })),
    });
  }

  await evaluateSelection();
  setInterval(() => {
    evaluateSelection().catch((err) => logger.error("selection failed", { error: (err as Error).message }));
  }, config.evalIntervalMs);

  let polling = false;
  const pollLimit = createLimiter(4);

  async function pollTrades() {
    if (polling) return;
    polling = true;
    try {
      const tasks = resolvedTargets.map((target) =>
        pollLimit(async () => {
          try {
            const { trades, newestTimestamp } = await fetchNewTradesForTarget(target, state);
            if (!trades.length) return;
            for (const trade of trades) {
              const { copy, weight } = shouldCopyTrade(selection, trade);
              if (!copy) continue;
              const keyResult = buildTradeKey(trade);
              if (!keyResult.key) {
                if (keyResult.persistKey && state.hasProcessed(keyResult.persistKey)) {
                  continue;
                }
                if (keyResult.persistKey) {
                  state.markProcessed(keyResult.persistKey, keyResult.reason || "missing required trade fields");
                }
                continue;
              }

              const key = keyResult.key;
              if (state.hasProcessed(key)) continue;

              try {
                const result = await mirrorTrade(trade, weight, config, state, publicClient, tradingClient);
                state.markProcessed(key, result.reason);
                if (result.status === "failed") {
                  failureReasons.set(key, result.errorMessage || result.reason);
                }
                if (result.status === "placed" || result.status === "dry_run") {
                  state.setLastTrade(key, trade.timestampMs);
                }
                const logPayload = {
                  proxyWallet: trade.proxyWallet,
                  conditionId: trade.conditionId,
                  outcomeIndex: trade.outcomeIndex,
                  side: trade.side,
                  reason: result.reason,
                  size: result.size,
                  limitPrice: result.limitPrice,
                  notional: result.notional,
                  status: result.status,
                  orderId: result.orderId,
                  error: result.errorMessage,
                  errorStatus: result.errorStatus,
                };
                if (result.status === "failed") {
                  logger.warn("trade mirrored", logPayload);
                } else {
                  logger.info("trade mirrored", logPayload);
                }
              } catch (err) {
                const message = (err as Error).message || "unknown error";
                failureReasons.set(key, message);
                state.markProcessed(key, "mirror failed");
                logger.warn("trade mirrored", {
                  proxyWallet: trade.proxyWallet,
                  conditionId: trade.conditionId,
                  outcomeIndex: trade.outcomeIndex,
                  side: trade.side,
                  status: "failed",
                  reason: "mirror failed",
                  error: message,
                });
              }
            }
            state.setLastSeen(target.proxyWallet, newestTimestamp);
          } catch (err) {
            logger.error("trade poll failed", { proxyWallet: target.proxyWallet, error: (err as Error).message });
          }
        })
      );
      await Promise.all(tasks);
    } finally {
      polling = false;
    }
  }

  await pollTrades();
  setInterval(() => {
    pollTrades().catch((err) => logger.error("poll failed", { error: (err as Error).message }));
  }, config.pollMs);

  setInterval(() => {
    const leaderState = state.getLeaderState();
    const lastTrade = state.getLastTrade();
    logger.info("status", {
      mode: selection.mode,
      currentLeader: leaderState.currentLeader || null,
      leaderSinceMs: leaderState.sinceMs || null,
      lastTradeKey: lastTrade.tradeKey || null,
      lastTradeTimestampMs: lastTrade.timestampMs || null,
    });
  }, Math.max(60000, config.evalIntervalMs));
}

run().catch((err) => {
  logger.error("fatal", { error: (err as Error).message });
  process.exit(1);
});
