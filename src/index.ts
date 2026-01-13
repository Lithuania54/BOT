import { loadConfig } from "./config";
import { checkGeoblock } from "./api/geoblock";
import { resolveTargetToProxyWallet } from "./api/gamma";
import { fetchTrades, normalizeTrade } from "./api/dataApi";
import { initClobClients } from "./clob";
import { buildTradeKey, mirrorTrade } from "./mirror";
import { startAutoRedeemLoop } from "./redeem";
import { StateStore } from "./state";
import { computeScores } from "./scoring";
import { selectLeaders } from "./selector";
import { LeaderSelection, ResolvedTarget, Trade } from "./types";
import { logger } from "./logger";
import { createLimiter } from "./limiter";
import { formatUsdcMicro } from "./preflight";
import { MirrorCursorStore } from "./cursor";
import { AllowanceManager } from "./allowance";

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
  state: StateStore,
  cursorMs: number
): Promise<{ trades: Trade[]; newestTimestamp: number }> {
  const storedLastSeen = state.getLastSeen(target.proxyWallet);
  const lastSeen = Math.max(storedLastSeen, cursorMs);
  if (storedLastSeen === 0 && lastSeen > 0) {
    state.setLastSeen(target.proxyWallet, lastSeen);
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
      } else {
        logger.debug("trade skipped", {
          reasonCode: "TRADE_TOO_OLD",
          proxyWallet: trade.proxyWallet,
          conditionId: trade.conditionId,
          outcomeIndex: trade.outcomeIndex,
          side: trade.side,
          tradeTimestampRaw: trade.timestampRaw || null,
          tradeTimestampMs: trade.timestampMs,
          lastSeenMs: lastSeen,
        });
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
  logger.info(`Copying trades ONLY from: ${config.targetTraderWallet}`);
  const cursorStore = new MirrorCursorStore(
    config.mirrorCursorFile,
    config.mirrorBootstrapLookbackMs,
    config.startFromNow
  );
  await cursorStore.load();

  const geo = await checkGeoblock();
  if (geo.blocked) {
    logger.error("geoblocked", { reason: geo.reason || "not eligible" });
    process.exit(1);
  }

  const { publicClient, tradingClient: initialTradingClient, startTradingClientRetry } = await initClobClients(config);
  let tradingClient = initialTradingClient;
  if (startTradingClientRetry) {
    startTradingClientRetry((client) => {
      tradingClient = client;
    });
  }
  logger.info("trading identity", {
    myUserAddress: config.myUserAddress,
    funderAddress: config.funderAddress,
    signatureType: config.signatureType,
  });

  const allowanceManager = new AllowanceManager(config);
  let tradingEnabled = true;
  let lastDisabledLogMs = 0;
  const allowanceCheckIntervalMs = Math.max(60000, config.pollMs);

  function updateTradingEnabled(status: { ok: boolean; owner: string; allowanceMicro: bigint }) {
    if (config.dryRun) {
      tradingEnabled = true;
      return;
    }
    const wasEnabled = tradingEnabled;
    tradingEnabled = status.ok;
    if (status.ok && !wasEnabled) {
      logger.info("USDC allowance sufficient; trading re-enabled", {
        owner: status.owner,
        allowance: formatUsdcMicro(status.allowanceMicro),
      });
    }
  }

  const startupAllowance = await allowanceManager.ensureAllowance({ reason: "startup" });
  if (!config.dryRun) {
    logger.info("allowance status", {
      owner: startupAllowance.owner,
      allowance: formatUsdcMicro(startupAllowance.allowanceMicro),
      required: formatUsdcMicro(startupAllowance.requiredMicro),
      ok: startupAllowance.ok,
    });
  }
  updateTradingEnabled(startupAllowance);

  startAutoRedeemLoop({
    config,
    state,
    publicClient,
  });

  const resolvedTargetsAll = await resolveTargets(config.targets, state);
  const targetWallet = config.targetTraderWallet.toLowerCase();
  const resolvedTargets = resolvedTargetsAll.filter(
    (target) => target.proxyWallet.toLowerCase() === targetWallet
  );
  if (resolvedTargets.length !== 1) {
    throw new Error(`Resolved targets must contain exactly ${targetWallet}.`);
  }
  for (const target of resolvedTargets) {
    cursorStore.ensureCursor(target.proxyWallet);
  }
  let selection: LeaderSelection = { mode: config.followMode, leaders: [], reason: "not evaluated" };
  const failureReasons = new Map<string, string>();
  const inMemoryTradeKeys = new Set<string>();
  let lastSignalMs = 0;
  let lastOrderMs = 0;
  let pollTimer: NodeJS.Timeout | undefined;

  async function evaluateSelection() {
    const scores = await computeScores(resolvedTargets, config, state);
    selection = selectLeaders(scores, config, state);
    logger.info("selection updated", {
      mode: selection.mode,
      reason: selection.reason,
      meta: selection.meta,
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
    let skippedDueToDisabled = 0;
    try {
      const tasks = resolvedTargets.map((target) =>
        pollLimit(async () => {
          try {
            const cursorMs = cursorStore.ensureCursor(target.proxyWallet);
            const { trades, newestTimestamp } = await fetchNewTradesForTarget(target, state, cursorMs);
            if (!trades.length) return;
            for (const trade of trades) {
              if (trade.proxyWallet.toLowerCase() !== targetWallet) {
                logger.warn("trade skipped", {
                  reasonCode: "NOT_TARGET_WALLET",
                  proxyWallet: trade.proxyWallet,
                  conditionId: trade.conditionId,
                  outcomeIndex: trade.outcomeIndex,
                  side: trade.side,
                  tradeTimestampRaw: trade.timestampRaw || null,
                  tradeTimestampMs: trade.timestampMs,
                });
                continue;
              }
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
              if (inMemoryTradeKeys.has(key)) {
                logger.debug("trade skipped", {
                  reasonCode: "DUPLICATE",
                  proxyWallet: trade.proxyWallet,
                  conditionId: trade.conditionId,
                  outcomeIndex: trade.outcomeIndex,
                  side: trade.side,
                  tradeTimestampRaw: trade.timestampRaw || null,
                  tradeTimestampMs: trade.timestampMs,
                  key,
                });
                continue;
              }
              inMemoryTradeKeys.add(key);
              if (inMemoryTradeKeys.size > 50000) {
                inMemoryTradeKeys.clear();
              }
              if (state.hasProcessed(key)) {
                logger.debug("trade skipped", {
                  reasonCode: "DUPLICATE",
                  proxyWallet: trade.proxyWallet,
                  conditionId: trade.conditionId,
                  outcomeIndex: trade.outcomeIndex,
                  side: trade.side,
                  tradeTimestampRaw: trade.timestampRaw || null,
                  tradeTimestampMs: trade.timestampMs,
                  key,
                });
                continue;
              }

              if (!tradingEnabled) {
                skippedDueToDisabled += 1;
                state.markProcessed(key, "trading disabled (allowance too low)");
                continue;
              }

              try {
                const result = await mirrorTrade(
                  trade,
                  weight,
                  config,
                  state,
                  publicClient,
                  tradingClient,
                  allowanceManager
                );
                state.markProcessed(key, result.reason);
                if (result.status === "skipped" && result.reason === "allowance too low") {
                  tradingEnabled = false;
                }
                if (result.status === "failed") {
                  failureReasons.set(key, result.errorMessage || result.reason);
                }
                if (result.status !== "skipped") {
                  lastSignalMs = Date.now();
                }
                if (result.status === "placed" || result.status === "dry_run") {
                  state.setLastTrade(key, trade.timestampMs);
                  lastOrderMs = Date.now();
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
                  errorResponse: result.errorResponse,
                  errorDiagnostics: result.errorDiagnostics,
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
            cursorStore.updateCursor(target.proxyWallet, newestTimestamp);
          } catch (err) {
            logger.error("trade poll failed", { proxyWallet: target.proxyWallet, error: (err as Error).message });
          }
        })
      );
      await Promise.all(tasks);
      await cursorStore.persist();
    } finally {
      const now = Date.now();
      if (skippedDueToDisabled > 0 && now - lastDisabledLogMs > allowanceCheckIntervalMs) {
        logger.warn("trading disabled: skipping order placement", {
          reason: "allowance too low",
          skippedTrades: skippedDueToDisabled,
        });
        lastDisabledLogMs = now;
      }
      polling = false;
    }
  }

  function startPollingLoop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      pollTrades().catch((err) => logger.error("poll failed", { error: (err as Error).message }));
    }, config.pollMs);
  }

  await pollTrades();
  startPollingLoop();
  setInterval(() => {
    allowanceManager
      .ensureAllowance({ reason: "interval" })
      .then(updateTradingEnabled)
      .catch((err) => logger.error("allowance check failed", { error: (err as Error).message }));
  }, allowanceCheckIntervalMs);

  setInterval(() => {
    const now = Date.now();
    if (!tradingEnabled) return;
    if (!lastSignalMs || !config.noOrderLivenessMs) return;
    if (now - lastSignalMs <= config.noOrderLivenessMs && now - lastOrderMs > config.noOrderLivenessMs) {
      logger.error("liveness watchdog: signals received but no successful order", {
        lastSignalMs,
        lastOrderMs: lastOrderMs || null,
        lastSignalAgeMs: now - lastSignalMs,
        lastOrderAgeMs: lastOrderMs ? now - lastOrderMs : null,
        windowMs: config.noOrderLivenessMs,
      });
      startPollingLoop();
      pollTrades().catch((err) => logger.error("poll failed", { error: (err as Error).message }));
    }
  }, Math.max(60000, config.pollMs * 5));

  setInterval(() => {
    const leaderState = state.getLeaderState();
    const lastTrade = state.getLastTrade();
    logger.info("status", {
      mode: selection.mode,
      currentLeader: leaderState.currentLeader || null,
      leaderSinceMs: leaderState.sinceMs || null,
      lastTradeKey: lastTrade.tradeKey || null,
      lastTradeTimestampMs: lastTrade.timestampMs || null,
      tradingEnabled,
    });
  }, Math.max(60000, config.evalIntervalMs));
}

run().catch((err) => {
  logger.error("fatal", { error: (err as Error).message });
  process.exit(1);
});
