import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Config, MirrorResult, Trade } from "./types";
import { StateStore } from "./state";
import { fetchPositions } from "./api/dataApi";
import { getClobTokenIdsForCondition, getMarketByConditionId } from "./api/gamma";
import {
  computeGtdExpirationSeconds,
  getExecutablePriceFromBook,
  getExecutablePriceFromGetPrice,
  getOrderbookMeta,
  roundPriceToTick,
} from "./clob";
import { logger } from "./logger";

const DEBUG_LOG_LIMIT = 3;
let debugLogged = 0;

function todayKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function countDecimals(value: string): number {
  const idx = value.indexOf(".");
  return idx === -1 ? 0 : value.length - idx - 1;
}

function roundSize(value: number, precision: number): number {
  if (precision <= 0) return Math.floor(value);
  const factor = Math.pow(10, precision);
  return Math.floor(value * factor) / factor;
}

function parseMarketEndMs(market: any): number | null {
  if (!market) return null;
  const candidates = [
    market?.end_date,
    market?.endDate,
    market?.close_time,
    market?.closeTime,
    market?.close_timestamp,
    market?.closeTimestamp,
    market?.resolution_time,
    market?.resolutionTime,
    market?.resolve_time,
    market?.resolveTime,
    market?.end_time,
    market?.endTime,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "number") {
      return candidate < 1e12 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (!Number.isNaN(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function extractErrorInfo(err: unknown): { message: string; status?: number | string } {
  const anyErr = err as any;
  const message = anyErr?.message || "unknown error";
  const status = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.code;
  return { message, status };
}

function tradeSnippet(trade: Trade) {
  return {
    transactionHash: trade.transactionHash,
    conditionId: trade.conditionId,
    outcomeIndex: trade.outcomeIndex,
    side: trade.side,
    size: trade.size,
    price: trade.price,
    timestamp: trade.timestampMs,
  };
}

function validateTradeRequiredFields(trade: Trade, logIfInvalid: boolean): boolean {
  const missing: string[] = [];
  if (!trade.proxyWallet) missing.push("proxyWallet");
  if (!trade.transactionHash) missing.push("transactionHash");
  if (!trade.conditionId) missing.push("conditionId");
  if (!Number.isFinite(trade.outcomeIndex)) missing.push("outcomeIndex");
  if (trade.side !== "BUY" && trade.side !== "SELL") missing.push("side");
  if (!Number.isFinite(trade.size)) missing.push("size");
  if (!Number.isFinite(trade.price)) missing.push("price");
  if (!Number.isFinite(trade.timestampMs)) missing.push("timestamp");

  if (missing.length > 0) {
    if (logIfInvalid) {
      logger.warn("trade skipped", {
        reason: "missing required trade fields",
        missing,
        snippet: tradeSnippet(trade),
      });
    }
    return false;
  }
  return true;
}

export function buildTradeKey(trade: Trade): {
  key?: string;
  persistKey?: string;
  reason?: string;
  snippet?: Record<string, unknown>;
} {
  const valid = validateTradeRequiredFields(trade, true);
  if (!valid) {
    const canPersist = Boolean(trade.transactionHash) && Number.isFinite(trade.timestampMs);
    const persistKey = canPersist
      ? `invalid:${trade.proxyWallet || "unknown"}:${trade.transactionHash}:${trade.timestampMs}`
      : undefined;
    return {
      reason: "missing required trade fields",
      snippet: tradeSnippet(trade),
      persistKey,
    };
  }

  const key = `${trade.proxyWallet}:${trade.transactionHash}:${trade.conditionId}:${trade.outcomeIndex}:${trade.side}:${trade.size}:${trade.price}:${trade.timestampMs}`;
  return { key };
}

function validateTokenId(
  tokenId: string,
  conditionId: string,
  outcomeIndex: number,
  lookupSummary: Record<string, unknown>
): { ok: boolean; reason?: string } {
  if (!tokenId || typeof tokenId !== "string") {
    logger.warn("trade skipped", {
      reason: "missing tokenId",
      conditionId,
      outcomeIndex,
      tokenID: tokenId,
      marketLookupResponseSummary: lookupSummary,
    });
    return { ok: false, reason: "missing tokenId" };
  }

  if (tokenId === conditionId || /^0x[0-9a-fA-F]{64}$/.test(tokenId)) {
    logger.warn("trade skipped", {
      reason: "tokenID looks like conditionId",
      conditionId,
      outcomeIndex,
      tokenID: tokenId,
      marketLookupResponseSummary: lookupSummary,
    });
    return { ok: false, reason: "tokenID looks like conditionId" };
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(tokenId)) {
    logger.warn("trade skipped", {
      reason: "tokenID looks like address",
      conditionId,
      outcomeIndex,
      tokenID: tokenId,
      marketLookupResponseSummary: lookupSummary,
    });
    return { ok: false, reason: "tokenID looks like address" };
  }

  return { ok: true };
}

export async function mirrorTrade(
  trade: Trade,
  weight: number,
  config: Config,
  state: StateStore,
  publicClient: ClobClient,
  tradingClient?: ClobClient
): Promise<MirrorResult> {
  if (!validateTradeRequiredFields(trade, false)) {
    return { status: "skipped", reason: "missing required trade fields" };
  }

  const tokenIds = await getClobTokenIdsForCondition(trade.conditionId, state);
  const tokenId = tokenIds[trade.outcomeIndex];
  const lookupSummary = {
    tokenIdsCount: tokenIds.length,
    tokenIdsSample: tokenIds.slice(0, 3),
  };
  const tokenValidation = validateTokenId(tokenId, trade.conditionId, trade.outcomeIndex, lookupSummary);
  if (!tokenValidation.ok) {
    return { status: "skipped", reason: tokenValidation.reason || "invalid tokenId" };
  }

  if (trade.side === "BUY") {
    try {
      const market = await getMarketByConditionId(trade.conditionId);
      const endMs = parseMarketEndMs(market);
      if (endMs) {
        const nowMs = Date.now();
        const safetyMs = config.marketEndSafetySeconds * 1000;
        if (nowMs >= endMs - safetyMs) {
          return { status: "skipped", reason: "market expired/too close to end" };
        }
        const ttlMs = config.orderTtlSeconds * 1000;
        if (nowMs + ttlMs >= endMs - safetyMs) {
          return { status: "skipped", reason: "order TTL crosses market end" };
        }
      }
    } catch (err) {
      logger.warn("market end lookup failed", { conditionId: trade.conditionId, error: (err as Error).message });
    }
  }

  const bookResult = await getExecutablePriceFromBook(publicClient, tokenId, trade.side as Side);
  let execPrice = bookResult.price;
  let rawGetPriceResponse: unknown;
  let execError: string | undefined = bookResult.error;

  if (!Number.isFinite(execPrice) || execPrice <= 0) {
    const priceResult = await getExecutablePriceFromGetPrice(publicClient, tokenId, trade.side as Side);
    execPrice = priceResult.price;
    rawGetPriceResponse = priceResult.raw;
    execError = execError || priceResult.error;
  }

  if (!Number.isFinite(execPrice) || execPrice <= 0) {
    logger.warn("trade skipped", {
      reason: "invalid exec price",
      conditionId: trade.conditionId,
      outcomeIndex: trade.outcomeIndex,
      tokenID: tokenId,
      side: trade.side,
      bookTop: bookResult.top,
      rawGetPriceResponse,
      error: execError,
    });
    return { status: "skipped", reason: "invalid exec price" };
  }

  if (debugLogged < DEBUG_LOG_LIMIT && (process.env.LOG_LEVEL || "").toLowerCase() === "debug") {
    logger.debug("trade debug", {
      conditionId: trade.conditionId,
      outcomeIndex: trade.outcomeIndex,
      tokenID: tokenId,
      bookTop: bookResult.top,
    });
    debugLogged += 1;
  }

  const meta = await getOrderbookMeta(tokenId, publicClient, state);

  const tradeNotional = trade.price * trade.size;
  if (tradeNotional <= 0) {
    return { status: "skipped", reason: "invalid trade notional" };
  }

  if (weight <= 0) {
    return { status: "skipped", reason: "non-positive weight" };
  }

  const desiredNotional = Math.min(tradeNotional * config.copyRatio * weight, config.maxUsdcPerTrade);
  if (desiredNotional <= 0) {
    return { status: "skipped", reason: "non-positive desired notional" };
  }
  if (config.maxDailyUsdc !== undefined) {
    const dateKey = todayKey();
    const spent = state.getDailyNotional(dateKey);
    if (spent + desiredNotional > config.maxDailyUsdc) {
      return { status: "skipped", reason: "daily cap reached" };
    }
  }

  let shares = desiredNotional / execPrice;
  shares = Math.min(shares, config.maxSharesPerTrade);

  if (trade.side === "SELL") {
    const positions = await fetchPositions(config.myUserAddress, trade.conditionId);
    const position = positions.find(
      (row) => row.conditionId === trade.conditionId && row.outcomeIndex === trade.outcomeIndex
    );
    const availableShares = Math.max(0, position?.size || 0);
    shares = Math.min(shares, availableShares);
  }

  const minOrderSize = Number(meta.minOrderSize);
  const sizePrecision = countDecimals(meta.minOrderSize);
  shares = roundSize(shares, sizePrecision);
  if (shares <= 0 || shares < minOrderSize) {
    return { status: "skipped", reason: "size below min" };
  }

  const limitPriceRaw =
    trade.side === "BUY"
      ? execPrice * (1 + config.slippagePct)
      : execPrice * (1 - config.slippagePct);
  const limitPrice = roundPriceToTick(limitPriceRaw, meta.tickSize, trade.side);
  if (limitPrice <= 0) {
    return { status: "skipped", reason: "invalid limit price" };
  }

  const notional = shares * limitPrice;
  if (config.maxDailyUsdc !== undefined) {
    const dateKey = todayKey();
    const spent = state.getDailyNotional(dateKey);
    if (spent + notional > config.maxDailyUsdc) {
      return { status: "skipped", reason: "daily cap reached" };
    }
  }

  if (config.dryRun || !tradingClient) {
    state.addDailyNotional(todayKey(), notional);
    return { status: "dry_run", reason: "dry run", notional, size: shares, limitPrice };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiration = computeGtdExpirationSeconds(
    nowSeconds,
    config.orderTtlSeconds,
    config.expirationSafetySeconds
  );
  const userOrder = {
    tokenID: tokenId,
    price: limitPrice,
    size: shares,
    side: trade.side === "BUY" ? Side.BUY : Side.SELL,
    expiration,
  };

  try {
    const resp = await tradingClient.createAndPostOrder(userOrder, {
      tickSize: meta.tickSize as any,
      negRisk: meta.negRisk,
    }, OrderType.GTD);
    state.addDailyNotional(todayKey(), notional);
    const orderId = resp?.orderID ?? resp?.orderId ?? resp?.id;
    if (resp?.success === false) {
      return {
        status: "failed",
        reason: "order rejected",
        errorMessage: resp?.message || "CLOB rejected order",
        errorStatus: resp?.status,
      };
    }
    return { status: "placed", reason: "order placed", orderId, notional, size: shares, limitPrice };
  } catch (err) {
    const info = extractErrorInfo(err);
    const message = info.message || "unknown error";
    if (message.toLowerCase().includes("gtd") || message.toLowerCase().includes("expiration")) {
      logger.warn("GTD order failed, falling back to GTC", { error: message });
      const userOrderNoExp = {
        tokenID: tokenId,
        price: limitPrice,
        size: shares,
        side: trade.side === "BUY" ? Side.BUY : Side.SELL,
      };
      try {
        const resp = await tradingClient.createAndPostOrder(userOrderNoExp, {
          tickSize: meta.tickSize as any,
          negRisk: meta.negRisk,
        }, OrderType.GTC);
        state.addDailyNotional(todayKey(), notional);
        const orderId = resp?.orderID ?? resp?.orderId ?? resp?.id;
        if (resp?.success === false) {
          return {
            status: "failed",
            reason: "order rejected",
            errorMessage: resp?.message || "CLOB rejected order",
            errorStatus: resp?.status,
          };
        }
        return { status: "placed", reason: "order placed", orderId, notional, size: shares, limitPrice };
      } catch (fallbackErr) {
        const fallbackInfo = extractErrorInfo(fallbackErr);
        return {
          status: "failed",
          reason: "order failed",
          errorMessage: fallbackInfo.message,
          errorStatus: fallbackInfo.status,
        };
      }
    }
    return {
      status: "failed",
      reason: "order failed",
      errorMessage: info.message,
      errorStatus: info.status,
    };
  }
}
