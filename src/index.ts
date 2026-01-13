import { AssetType } from "@polymarket/clob-client";
import { Contract, Wallet, constants } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";
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
import { formatUsdcMicro, parseUsdcToMicro } from "./preflight";
import { MirrorCursorStore } from "./cursor";

const TRADE_LIMIT = 1000;
const MAX_PAGES = 5;
const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_SPENDER_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
// Module-level guard avoids TDZ if checkAllowance is invoked before local declarations.
let allowanceCheckInFlight: Promise<void> | null = null;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function formatAllowanceDiagnostic(allowanceMicro: bigint, thresholdMicro: bigint) {
  return {
    allowance: formatUsdcMicro(allowanceMicro),
    threshold: formatUsdcMicro(thresholdMicro),
    token: USDCe_ADDRESS,
    spender: CTF_SPENDER_ADDRESS,
  };
}

function getAllowanceOwner(config: { signatureType: number; funderAddress?: string; myUserAddress: string }): string {
  if (config.signatureType === 1 || config.signatureType === 2) {
    return config.funderAddress || config.myUserAddress;
  }
  return config.myUserAddress;
}

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

  let tradingEnabled = true;
  let allowanceLogged = false;
  let lastAllowanceCheckMs = 0;
  let lastApproveAttemptMs = 0;
  const allowanceCheckIntervalMs = Math.max(60000, config.pollMs);

  async function checkAllowance(reason: "startup" | "interval"): Promise<void> {
    if (allowanceCheckInFlight) return allowanceCheckInFlight;
    allowanceCheckInFlight = (async () => {
      if (config.dryRun || !tradingClient) return;
      try {
        const balance = await tradingClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const balanceMicro = parseUsdcToMicro(balance?.balance);
        const allowanceMicro = parseUsdcToMicro(balance?.allowance);
        const thresholdMicro = parseUsdcToMicro(config.allowanceThresholdUsdc);
        const funderOwner = getAllowanceOwner(config);

        logger.info("allowance check", {
          reason,
          funderAddress: funderOwner,
          balance: formatUsdcMicro(balanceMicro),
          allowance: formatUsdcMicro(allowanceMicro),
          allowanceToken: USDCe_ADDRESS,
          allowanceSpender: CTF_SPENDER_ADDRESS,
        });

        if (thresholdMicro > 0n && allowanceMicro < thresholdMicro) {
          tradingEnabled = false;
          const diagnostic = {
            ...formatAllowanceDiagnostic(allowanceMicro, thresholdMicro),
            funderAddress: funderOwner,
            signatureType: config.signatureType,
          };

          if (config.autoApprove) {
            if (funderOwner !== config.myUserAddress) {
              if (!allowanceLogged) {
                logger.error(
                  "AUTO_APPROVE disabled for proxy wallets. Approve USDC.e in the Polymarket UI for FUNDER_ADDRESS.",
                  diagnostic
                );
                allowanceLogged = true;
              }
            } else if (!config.rpcUrl) {
              if (!allowanceLogged) {
                logger.error("AUTO_APPROVE requested but RPC_URL is missing", diagnostic);
                allowanceLogged = true;
              }
            } else if (config.signatureType !== 0) {
              if (!allowanceLogged) {
                logger.error("AUTO_APPROVE only supported for SIGNATURE_TYPE=0 (EOA)", diagnostic);
                allowanceLogged = true;
              }
            } else {
              const now = Date.now();
              if (now - lastApproveAttemptMs > 5 * 60 * 1000) {
                lastApproveAttemptMs = now;
                const provider = new JsonRpcProvider(config.rpcUrl);
                const signer = new Wallet(config.privateKey as string, provider);
                const token = new Contract(USDCe_ADDRESS, ERC20_ABI, signer);

                logger.info("submitting USDC approval", {
                  token: USDCe_ADDRESS,
                  spender: CTF_SPENDER_ADDRESS,
                });
                const tx = await token.approve(CTF_SPENDER_ADDRESS, constants.MaxUint256);
                logger.info("approval submitted", { hash: tx.hash, token: USDCe_ADDRESS, spender: CTF_SPENDER_ADDRESS });
                const receipt = await tx.wait();
                logger.info("approval confirmed", {
                  hash: receipt?.transactionHash,
                  blockNumber: receipt?.blockNumber,
                });
              }
            }
          } else if (!allowanceLogged) {
            logger.error("USDC allowance too low; approval required before trading", diagnostic);
            logger.error(
              "Approve USDC.e for trading in the Polymarket UI (proxy wallets), or set AUTO_APPROVE=true for EOA."
            );
            allowanceLogged = true;
          }
        } else if (!tradingEnabled) {
          tradingEnabled = true;
          allowanceLogged = false;
          logger.info("USDC allowance sufficient; trading re-enabled", {
            funderAddress: funderOwner,
            allowance: formatUsdcMicro(allowanceMicro),
          });
        }
      } catch (err) {
        logger.error("allowance check failed", { error: (err as Error).message });
      } finally {
        lastAllowanceCheckMs = Date.now();
      }
    })().finally(() => {
      allowanceCheckInFlight = null;
    });
    return allowanceCheckInFlight;
  }

  await checkAllowance("startup");

  startAutoRedeemLoop({
    config,
    state,
    publicClient,
  });

  const resolvedTargets = await resolveTargets(config.targets, state);
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
              const { copy, weight } = shouldCopyTrade(selection, trade);
              if (!copy) continue;
              lastSignalMs = Date.now();
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
              if (inMemoryTradeKeys.has(key)) continue;
              inMemoryTradeKeys.add(key);
              if (inMemoryTradeKeys.size > 50000) {
                inMemoryTradeKeys.clear();
              }
              if (state.hasProcessed(key)) continue;

              if (!tradingEnabled) {
                skippedDueToDisabled += 1;
                state.markProcessed(key, "trading disabled (allowance too low)");
                continue;
              }

              try {
                const result = await mirrorTrade(trade, weight, config, state, publicClient, tradingClient);
                state.markProcessed(key, result.reason);
                if (result.status === "failed") {
                  failureReasons.set(key, result.errorMessage || result.reason);
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
      if (skippedDueToDisabled > 0) {
        logger.warn("trading disabled: skipping order placement", {
          reason: "allowance too low",
          skippedTrades: skippedDueToDisabled,
        });
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
    checkAllowance("interval").catch((err) =>
      logger.error("allowance check failed", { error: (err as Error).message })
    );
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
