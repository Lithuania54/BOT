import { ClobClient } from "@polymarket/clob-client";
import { RelayClient, RelayerTxType, Transaction } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { constants, utils } from "ethers";
import { fetchPositions } from "./api/dataApi";
import { Config } from "./types";
import { StateStore } from "./state";
import { logger } from "./logger";

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const redeemInterface = new utils.Interface([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

function extractOutcomeIndex(token: any): number | null {
  const raw = token?.outcomeIndex ?? token?.outcome_index ?? token?.index ?? token?.outcome;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function buildIndexSets(market: any): string[] {
  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const indexSets: string[] = [];
  for (const token of tokens) {
    const outcomeIndex = extractOutcomeIndex(token);
    if (outcomeIndex === null) continue;
    const indexSet = (1n << BigInt(outcomeIndex)).toString();
    indexSets.push(indexSet);
  }
  return indexSets.length ? indexSets : ["1", "2"];
}

function extractErrorInfo(err: unknown): { message: string; status?: number | string } {
  const anyErr = err as any;
  const message = anyErr?.message || "unknown error";
  const status = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.code;
  return { message, status };
}

function canAutoRedeem(config: Config): boolean {
  return Boolean(
    config.relayerEnabled &&
      config.builderApiKey &&
      config.builderSecret &&
      config.builderPassphrase &&
      config.privateKey &&
      config.rpcUrl
  );
}

function createRelayClient(config: Config): RelayClient | null {
  if (!canAutoRedeem(config)) return null;

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: config.builderApiKey as string,
      secret: config.builderSecret as string,
      passphrase: config.builderPassphrase as string,
    },
  });

  const provider = new JsonRpcProvider(config.rpcUrl as string);
  const signer = new Wallet(config.privateKey as string, provider);

  return new RelayClient(config.relayerUrl, config.chainId, signer, builderConfig, RelayerTxType.SAFE);
}

export function startAutoRedeemLoop(deps: {
  config: Config;
  state: StateStore;
  publicClient: ClobClient;
}): () => void {
  const { config, publicClient } = deps;

  if (!config.autoRedeemEnabled) {
    logger.info("auto-redeem loop stopped", { reason: "disabled" });
    return () => undefined;
  }

  logger.info("auto-redeem loop started", { pollMs: config.redeemPollMs });

  const lastAttemptMs = new Map<string, number>();
  let relayClient: RelayClient | null = null;

  const shouldAttempt = (conditionId: string, now: number) => {
    const last = lastAttemptMs.get(conditionId) || 0;
    return now - last >= config.redeemCooldownMs;
  };

  const markAttempt = (conditionId: string, now: number) => {
    lastAttemptMs.set(conditionId, now);
  };

  const loop = async () => {
    try {
      if (!relayClient && canAutoRedeem(config)) {
        relayClient = createRelayClient(config);
      }

      const positions = await fetchPositions(config.myUserAddress);
      const conditionIds = new Set<string>();
      for (const position of positions) {
        if (position.size > 0 && position.conditionId) {
          conditionIds.add(position.conditionId);
        }
      }

      for (const conditionId of conditionIds) {
        try {
          const market = await publicClient.getMarket(conditionId);
          if (!market?.closed) continue;

          const now = Date.now();
          if (!shouldAttempt(conditionId, now)) continue;
          markAttempt(conditionId, now);

          logger.info("market resolved", { conditionId });

          if (!relayClient) {
            logger.warn("auto-redeem skipped", {
              conditionId,
              reason: "missing relayer credentials",
              message:
                "Market resolved and positions appear redeemable, but auto-redeem requires builder relayer credentials; redeem manually in UI.",
            });
            continue;
          }

          const indexSets = buildIndexSets(market);
          const data = redeemInterface.encodeFunctionData("redeemPositions", [
            USDCe_ADDRESS,
            constants.HashZero,
            conditionId,
            indexSets,
          ]);

          const tx: Transaction = {
            to: CTF_ADDRESS,
            data,
            value: "0",
          };

          const resp = await relayClient.execute([tx], "Redeem winning tokens");
          const result = await resp.wait();

          logger.info("redeem success", {
            conditionId,
            transactionId: resp.transactionID,
            transactionHash: resp.transactionHash || resp.hash || result?.transactionHash,
            state: result?.state || resp.state,
          });
        } catch (err) {
          const info = extractErrorInfo(err);
          logger.warn("redeem failed", { conditionId, error: info.message, status: info.status });
        }
      }
    } catch (err) {
      logger.error("auto-redeem loop error", { error: extractErrorInfo(err).message });
    }
  };

  const timer = setInterval(() => {
    loop().catch((err) => logger.error("auto-redeem loop error", { error: extractErrorInfo(err).message }));
  }, config.redeemPollMs);

  loop().catch((err) => logger.error("auto-redeem loop error", { error: extractErrorInfo(err).message }));

  return () => {
    clearInterval(timer);
    logger.info("auto-redeem loop stopped");
  };
}
