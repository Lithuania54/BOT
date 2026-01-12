import { ClobClient } from "@polymarket/clob-client";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { Contract, constants, utils } from "ethers";
import { fetchPositions } from "./api/dataApi";
import { Config } from "./types";
import { StateStore } from "./state";
import { logger } from "./logger";

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)",
];

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

function isRedeemConfigReady(config: Config): boolean {
  return Boolean(config.privateKey && config.rpcUrl && config.funderAddress);
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

  if (!isRedeemConfigReady(config)) {
    logger.error("auto-redeem disabled: PRIVATE_KEY, RPC_URL, and FUNDER_ADDRESS are required", {
      hasPrivateKey: Boolean(config.privateKey),
      hasRpcUrl: Boolean(config.rpcUrl),
      hasFunderAddress: Boolean(config.funderAddress),
    });
    return () => undefined;
  }

  logger.info("auto-redeem loop started", { pollMs: config.redeemPollMs });

  const lastAttemptMs = new Map<string, number>();
  const provider = new JsonRpcProvider(config.rpcUrl as string);
  const signer = new Wallet(config.privateKey as string, provider);
  const safeAddress = config.funderAddress as string;
  const safeContract = new Contract(safeAddress, SAFE_ABI, signer);
  let safeChecked = false;
  let safeReady = false;
  let safeOwners: string[] = [];
  let safeThreshold = 0;

  const ensureSafeReady = async () => {
    if (safeChecked) return safeReady;
    safeChecked = true;
    try {
      const [owners, threshold] = await Promise.all([safeContract.getOwners(), safeContract.getThreshold()]);
      safeOwners = owners.map((owner: string) => owner.toLowerCase());
      safeThreshold = Number(threshold);
      const signerAddress = (await signer.getAddress()).toLowerCase();
      const isOwner = safeOwners.includes(signerAddress);
      if (!isOwner || safeThreshold !== 1) {
        logger.error("safe configuration not supported", {
          safe: safeAddress,
          threshold: safeThreshold,
          owners: safeOwners,
          signer: signerAddress,
        });
        safeReady = false;
        return false;
      }
      safeReady = true;
      return true;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("failed to read safe configuration", { safe: safeAddress, error: info.message, status: info.status });
      safeReady = false;
      return false;
    }
  };

  const shouldAttempt = (conditionId: string, now: number) => {
    const last = lastAttemptMs.get(conditionId) || 0;
    return now - last >= config.redeemCooldownMs;
  };

  const markAttempt = (conditionId: string, now: number) => {
    lastAttemptMs.set(conditionId, now);
  };

  const executeRedeem = async (conditionId: string, market: any) => {
    const indexSets = buildIndexSets(market);
    const data = redeemInterface.encodeFunctionData("redeemPositions", [
      USDCe_ADDRESS,
      constants.HashZero,
      conditionId,
      indexSets,
    ]);

    const nonce = await safeContract.nonce();
    const operation = 0;
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = constants.AddressZero;
    const refundReceiver = constants.AddressZero;

    const safeTxHash = await safeContract.getTransactionHash(
      CTF_ADDRESS,
      0,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce
    );

    const signature = signer._signingKey().signDigest(safeTxHash);
    const signatures = utils.joinSignature(signature);

    const tx = await safeContract.execTransaction(
      CTF_ADDRESS,
      0,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      signatures
    );

    const receipt = await tx.wait();
    logger.info("redeem success", {
      conditionId,
      transactionHash: receipt?.transactionHash,
      blockNumber: receipt?.blockNumber,
    });
  };

  const loop = async () => {
    try {
      const ready = await ensureSafeReady();
      if (!ready) return;

      const positions = await fetchPositions(config.funderAddress as string);
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

          await executeRedeem(conditionId, market);
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
