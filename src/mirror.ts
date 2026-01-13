import { AssetType, ClobClient, OrderType, Side, UserOrder } from "@polymarket/clob-client";
import { Config, MirrorResult, Trade } from "./types";
import { StateStore } from "./state";
import { fetchPositions } from "./api/dataApi";
import { getClobTokenIdsForCondition, getMarketByConditionId } from "./api/gamma";
import { AllowanceManager } from "./allowance";
import {
  computeGtdExpirationSeconds,
  getExecutablePriceFromBook,
  getExecutablePriceFromGetPrice,
  getOrderbookMeta,
  roundPriceToTick,
} from "./clob";
import { logger } from "./logger";
import { evaluateMarketCategory, extractMarketTitle } from "./marketFilter";
import {
  calculateAvailableUsdcMicro,
  computeReservedUsdcMicro,
  formatUsdcMicro,
  parseUsdcToMicro,
} from "./preflight";

const DEBUG_LOG_LIMIT = 3;
const ORDER_RETRY_DELAYS_MS = [1000, 2000, 4000];
const AUTH_BACKOFF_MS = 60 * 1000;
let debugLogged = 0;
let balanceCooldownUntilMs = 0;
let lastAuthOkMs = 0;
let authFailure: { message: string; status?: number | string; at: number } | null = null;
let lastPreflightSnapshot:
  | {
      balanceMicro: bigint;
      allowanceMicro: bigint;
      reservedMicro: bigint;
      availableMicro: bigint;
      at: number;
    }
  | null = null;
const expiredLogCache = new Set<string>();

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

function logDecision(reasonCode: string, trade: Trade, extra?: Record<string, unknown>) {
  logger.warn("trade skipped", {
    reasonCode,
    proxyWallet: trade.proxyWallet,
    conditionId: trade.conditionId,
    outcomeIndex: trade.outcomeIndex,
    side: trade.side,
    ...extra,
  });
}

function logExpiredDecision(trade: Trade, extra?: Record<string, unknown>) {
  const key = `${trade.conditionId}:${trade.outcomeIndex}:${trade.side}`;
  const payload = {
    reasonCode: "SKIP_MARKET_EXPIRED",
    proxyWallet: trade.proxyWallet,
    conditionId: trade.conditionId,
    outcomeIndex: trade.outcomeIndex,
    side: trade.side,
    ...extra,
  };
  if (expiredLogCache.has(key)) {
    logger.debug("trade skipped", payload);
    return;
  }
  expiredLogCache.add(key);
  logger.warn("trade skipped", payload);
}

type MarketEndParse = {
  endMs: number | null;
  source?: string;
  normalized?: string;
  raw: Record<string, unknown>;
};

function hasTimeComponent(value: string): boolean {
  return /\d{2}:\d{2}/.test(value);
}

function normalizeIsoTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!hasTimeComponent(trimmed)) return null;
  let normalized = trimmed;
  if (!normalized.includes("T") && normalized.includes(" ")) {
    normalized = normalized.replace(" ", "T");
  }
  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized);
  if (!hasTimezone) {
    normalized = `${normalized}Z`;
  }
  return normalized;
}

function parseMarketEndCandidate(value: unknown): { endMs: number; normalized?: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return { endMs: value < 1e12 ? value * 1000 : value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return { endMs: numeric < 1e12 ? numeric * 1000 : numeric };
    }
    const normalized = normalizeIsoTimestamp(trimmed);
    if (!normalized) return null;
    const parsed = Date.parse(normalized);
    if (Number.isNaN(parsed)) return null;
    return { endMs: parsed, normalized };
  }
  return null;
}

// Market end fields are parsed from Gamma metadata (ISO string, unix seconds, or unix ms).
function parseMarketEndMs(market: any, allowedKeys?: string[]): MarketEndParse {
  if (!market) return { endMs: null, raw: {} };
  const candidates: Array<{ key: string; value: unknown }> = [
    { key: "endDateIso", value: market?.endDateIso },
    { key: "end_date_iso", value: market?.end_date_iso },
    { key: "endDate", value: market?.endDate },
    { key: "end_date", value: market?.end_date },
    { key: "closeTime", value: market?.closeTime },
    { key: "close_time", value: market?.close_time },
    { key: "closedTime", value: market?.closedTime },
    { key: "closed_time", value: market?.closed_time },
    { key: "close_timestamp", value: market?.close_timestamp },
    { key: "closeTimestamp", value: market?.closeTimestamp },
    { key: "resolution_time", value: market?.resolution_time },
    { key: "resolutionTime", value: market?.resolutionTime },
    { key: "resolve_time", value: market?.resolve_time },
    { key: "resolveTime", value: market?.resolveTime },
    { key: "end_time", value: market?.end_time },
    { key: "endTime", value: market?.endTime },
  ];

  const raw: Record<string, unknown> = {};
  for (const candidate of candidates) {
    raw[candidate.key] = candidate.value;
  }

  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  for (const candidate of candidates) {
    if (allowed && !allowed.has(candidate.key)) continue;
    const parsed = parseMarketEndCandidate(candidate.value);
    if (parsed) {
      return {
        endMs: parsed.endMs,
        source: candidate.key,
        normalized: parsed.normalized,
        raw,
      };
    }
  }
  return { endMs: null, raw };
}

function getMissingTradeFields(trade: Trade): string[] {
  const missing: string[] = [];
  if (!trade.proxyWallet) missing.push("proxyWallet");
  if (!trade.transactionHash) missing.push("transactionHash");
  if (!trade.conditionId) missing.push("conditionId");
  if (!Number.isFinite(trade.outcomeIndex)) missing.push("outcomeIndex");
  if (trade.side !== "BUY" && trade.side !== "SELL") missing.push("side");
  if (!Number.isFinite(trade.size)) missing.push("size");
  if (!Number.isFinite(trade.price)) missing.push("price");
  if (!Number.isFinite(trade.timestampMs)) missing.push("timestamp");
  return missing;
}

function getPositionsUserAddress(config: Config): string {
  if (config.signatureType === 1 || config.signatureType === 2) {
    return config.funderAddress || config.myUserAddress;
  }
  return config.myUserAddress;
}

function isBalanceCooldownActive(config: Config): boolean {
  if (config.balanceErrorCooldownMs <= 0) return false;
  return Date.now() < balanceCooldownUntilMs;
}

function isBalanceOrAllowanceError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not enough balance") ||
    lower.includes("insufficient balance") ||
    lower.includes("insufficient funds") ||
    lower.includes("allowance")
  );
}

function maybeTriggerBalanceCooldown(config: Config, message?: string) {
  if (!message) return;
  if (!isBalanceOrAllowanceError(message)) return;
  const until = Date.now() + config.balanceErrorCooldownMs;
  if (until > balanceCooldownUntilMs) {
    balanceCooldownUntilMs = until;
    logger.warn(
      "Insufficient USDC balance or allowance. Check USDC.e balance and approval for trading. Cooling down until",
      { until: new Date(until).toISOString() }
    );
  }
}

function extractErrorInfo(err: unknown): { message: string; status?: number | string; body?: unknown } {
  const anyErr = err as any;
  const message = anyErr?.message || "unknown error";
  const status = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.code;
  const body = anyErr?.response?.data ?? anyErr?.data;
  return { message, status, body };
}

function isAuthError(info: { message: string; status?: number | string }): boolean {
  const statusNum = Number(info.status);
  if (statusNum === 401 || statusNum === 403) return true;
  const msg = info.message.toLowerCase();
  return msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("api key");
}

function isNonceOrGasError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("nonce") ||
    lower.includes("replacement") ||
    lower.includes("underpriced") ||
    lower.includes("gas") ||
    lower.includes("fee too low")
  );
}

function isExpirationError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("gtd") || lower.includes("expiration");
}

function logCriticalOrderError(message: string, context: Record<string, unknown>) {
  const lower = message.toLowerCase();
  if (lower.includes("invalid_signature")) {
    logger.error("order failed: invalid signature", { reasonCode: "INVALID_SIGNATURE", ...context, error: message });
  } else if (lower.includes("invalid funder") || lower.includes("funder address")) {
    logger.error("order failed: invalid funder address", {
      reasonCode: "INVALID_FUNDER_ADDRESS",
      ...context,
      error: message,
    });
  } else if (isBalanceOrAllowanceError(message)) {
    logger.error("order failed: insufficient balance or allowance", {
      reasonCode: "INSUFFICIENT_BALANCE_ALLOWANCE",
      ...context,
      error: message,
    });
  } else if (lower.includes("order expired") || lower.includes("expired")) {
    logger.error("order failed: order expired", { reasonCode: "ORDER_EXPIRED", ...context, error: message });
  }
}

function markAuthOk() {
  lastAuthOkMs = Date.now();
  authFailure = null;
}

function markAuthFailure(message: string, status?: number | string) {
  authFailure = { message, status, at: Date.now() };
}

function snapshotPreflight(
  balanceMicro: bigint,
  allowanceMicro: bigint,
  reservedMicro: bigint,
  availableMicro: bigint
) {
  lastPreflightSnapshot = {
    balanceMicro,
    allowanceMicro,
    reservedMicro,
    availableMicro,
    at: Date.now(),
  };
}

function getPreflightDiagnostics(): Record<string, unknown> | undefined {
  if (!lastPreflightSnapshot) return undefined;
  return {
    balance: formatUsdcMicro(lastPreflightSnapshot.balanceMicro),
    allowance: formatUsdcMicro(lastPreflightSnapshot.allowanceMicro),
    reservedInOpenOrders: formatUsdcMicro(lastPreflightSnapshot.reservedMicro),
    availableToTrade: formatUsdcMicro(lastPreflightSnapshot.availableMicro),
    preflightAt: new Date(lastPreflightSnapshot.at).toISOString(),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const missing = getMissingTradeFields(trade);

  if (missing.length > 0) {
    if (logIfInvalid) {
      logger.warn("trade skipped", {
        reasonCode: "SKIP_MISSING_REQUIRED_FIELDS",
        reason: "missing required trade fields",
        missing,
        snippet: tradeSnippet(trade),
      });
    }
    return false;
  }
  return true;
}

type PreflightResult =
  | {
      ok: true;
      authOk: true;
      walletAddress?: string;
      funderAddress?: string;
      signatureType: number;
      balanceMicro: bigint;
      allowanceMicro: bigint;
      reservedMicro: bigint;
      availableMicro: bigint;
      lastAuthOkMs: number;
    }
  | {
      ok: false;
      authOk: boolean;
      reasonCode: string;
      reason: string;
      context: Record<string, unknown>;
    };

async function getSignerAddress(client: ClobClient): Promise<string | undefined> {
  try {
    if (!client.signer) return undefined;
    return await client.signer.getAddress();
  } catch {
    return undefined;
  }
}

function isValidAddress(value: string | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function tradingPreflight(
  tradingClient: ClobClient,
  config: Config,
  notional: number
): Promise<PreflightResult> {
  const walletAddress = await getSignerAddress(tradingClient);
  const funderAddress = config.funderAddress;
  const signatureType = config.signatureType;
  const baseContext: Record<string, unknown> = {
    walletAddress,
    funderAddress,
    signatureType,
    myUserAddress: config.myUserAddress,
    lastAuthOkMs: lastAuthOkMs || null,
  };

  if (signatureType === 0) {
    if (funderAddress && walletAddress && funderAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return {
        ok: false,
        authOk: true,
        reasonCode: "SKIP_FUNDER_MISMATCH",
        reason: "funder address does not match signer for signatureType=0",
        context: baseContext,
      };
    }
  } else if (signatureType === 1 || signatureType === 2) {
    if (!isValidAddress(funderAddress)) {
      return {
        ok: false,
        authOk: true,
        reasonCode: "SKIP_INVALID_FUNDER",
        reason: "funder address missing or invalid for proxy signatures",
        context: baseContext,
      };
    }
  } else {
    return {
      ok: false,
      authOk: true,
      reasonCode: "SKIP_INVALID_SIGNATURE_TYPE",
      reason: "signatureType must be 0, 1, or 2",
      context: baseContext,
    };
  }

  if (authFailure && Date.now() - authFailure.at < AUTH_BACKOFF_MS) {
    return {
      ok: false,
      authOk: false,
      reasonCode: "SKIP_AUTH_FAIL",
      reason: "recent authentication failure",
      context: { ...baseContext, authFailure },
    };
  }

  let balanceMicro = 0n;
  let allowanceMicro = 0n;
  let reservedMicro = 0n;
  try {
    const balanceResp = await tradingClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    balanceMicro = parseUsdcToMicro(balanceResp?.balance);
    allowanceMicro = parseUsdcToMicro(balanceResp?.allowance);
  } catch (err) {
    const info = extractErrorInfo(err);
    if (isAuthError(info)) {
      markAuthFailure(info.message, info.status);
      return {
        ok: false,
        authOk: false,
        reasonCode: "SKIP_AUTH_FAIL",
        reason: "authentication failed",
        context: { ...baseContext, error: info.message, status: info.status, response: info.body },
      };
    }
    return {
      ok: false,
      authOk: false,
      reasonCode: "SKIP_PREFLIGHT_ERROR",
      reason: "balance/allowance check failed",
      context: { ...baseContext, error: info.message, status: info.status, response: info.body },
    };
  }

  let openOrders: unknown;
  try {
    openOrders = await tradingClient.getOpenOrders(undefined, true);
  } catch (err) {
    const info = extractErrorInfo(err);
    if (isAuthError(info)) {
      markAuthFailure(info.message, info.status);
      return {
        ok: false,
        authOk: false,
        reasonCode: "SKIP_AUTH_FAIL",
        reason: "authentication failed",
        context: { ...baseContext, error: info.message, status: info.status, response: info.body },
      };
    }
    return {
      ok: false,
      authOk: false,
      reasonCode: "SKIP_PREFLIGHT_ERROR",
      reason: "open orders check failed",
      context: { ...baseContext, error: info.message, status: info.status, response: info.body },
    };
  }

  const ordersArray = Array.isArray(openOrders) ? openOrders : [];
  reservedMicro = computeReservedUsdcMicro(ordersArray);
  const availableMicro = calculateAvailableUsdcMicro(balanceMicro, allowanceMicro, reservedMicro);

  markAuthOk();
  snapshotPreflight(balanceMicro, allowanceMicro, reservedMicro, availableMicro);

  const neededMicro = parseUsdcToMicro(notional.toFixed(6));
  const context = {
    ...baseContext,
    balance: formatUsdcMicro(balanceMicro),
    allowance: formatUsdcMicro(allowanceMicro),
    reservedInOpenOrders: formatUsdcMicro(reservedMicro),
    availableToTrade: formatUsdcMicro(availableMicro),
    neededNotional: formatUsdcMicro(neededMicro),
    openOrdersCount: ordersArray.length,
  };

  if (availableMicro < neededMicro) {
    if (allowanceMicro < neededMicro) {
      return {
        ok: false,
        authOk: true,
        reasonCode: "SKIP_ALLOWANCE_LOW",
        reason: "allowance too low for desired notional",
        context: {
          ...context,
          advice: "Increase USDC.e allowance for trading in the Polymarket UI.",
        },
      };
    }
    if (reservedMicro > 0n && availableMicro === 0n) {
      return {
        ok: false,
        authOk: true,
        reasonCode: "SKIP_RESERVED_OPEN_ORDERS",
        reason: "collateral reserved in open orders",
        context: {
          ...context,
          advice: "Cancel open BUY orders or wait for fills to free collateral.",
        },
      };
    }
    return {
      ok: false,
      authOk: true,
      reasonCode: "SKIP_NO_AVAILABLE_COLLATERAL",
      reason: "insufficient available collateral",
      context: {
        ...context,
        advice: "Check USDC.e balance and allowance.",
      },
    };
  }

  return {
    ok: true,
    authOk: true,
    walletAddress,
    funderAddress,
    signatureType,
    balanceMicro,
    allowanceMicro,
    reservedMicro,
    availableMicro,
    lastAuthOkMs,
  };
}

function extractResponseMessage(resp: any): string | undefined {
  return (
    resp?.message ||
    resp?.errorMsg ||
    resp?.error_message ||
    resp?.error ||
    resp?.data?.message ||
    resp?.data?.error
  );
}

function extractResponseStatus(resp: any): number | string | undefined {
  return resp?.status ?? resp?.statusCode ?? resp?.code;
}

type LimitOrderType = OrderType.GTC | OrderType.GTD;

async function createAndPostWithRetry(
  client: ClobClient,
  userOrder: UserOrder,
  options: any,
  orderType: LimitOrderType
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= ORDER_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await client.createAndPostOrder(userOrder, options, orderType);
    } catch (err) {
      lastErr = err;
      const info = extractErrorInfo(err);
      if (isNonceOrGasError(info.message) && attempt < ORDER_RETRY_DELAYS_MS.length) {
        await sleep(ORDER_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
    return { ok: false, reason: "missing tokenId" };
  }

  if (tokenId === conditionId || /^0x[0-9a-fA-F]{64}$/.test(tokenId)) {
    return { ok: false, reason: "tokenID looks like conditionId" };
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(tokenId)) {
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
  tradingClient?: ClobClient,
  allowanceManager?: AllowanceManager
): Promise<MirrorResult> {
  const missingFields = getMissingTradeFields(trade);
  if (missingFields.length > 0) {
    logDecision("SKIP_MISSING_REQUIRED_FIELDS", trade, {
      missing: missingFields,
      snippet: tradeSnippet(trade),
    });
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
    logDecision("SKIP_INVALID_TOKEN_ID", trade, {
      reason: tokenValidation.reason,
      tokenID: tokenId,
      marketLookupResponseSummary: lookupSummary,
    });
    return { status: "skipped", reason: tokenValidation.reason || "invalid tokenId" };
  }

  if (trade.side === "BUY" && isBalanceCooldownActive(config)) {
    logDecision("SKIP_BALANCE_COOLDOWN", trade, {
      tokenID: tokenId,
      cooldownUntil: new Date(balanceCooldownUntilMs).toISOString(),
    });
    return { status: "skipped", reason: "balance/allowance cooldown" };
  }

  let market: any | null = null;
  let strictMarket = false;
  let marketTitle: string | undefined;

  let buyOrderTtlSeconds: number | null = null;
  if (trade.side === "BUY") {
    try {
      const { market: fetchedMarket, strict } = await getMarketByConditionId(trade.conditionId);
      market = fetchedMarket;
      strictMarket = strict;
      if (!market) {
        logDecision("SKIP_MARKET_METADATA_UNAVAILABLE", trade, {
          tokenID: tokenId,
          strict: strictMarket,
        });
        return { status: "skipped", reason: "market metadata unavailable" };
      }

      marketTitle = extractMarketTitle(market);
      const categoryDecision = evaluateMarketCategory(market, config);
      if (!categoryDecision.allowed) {
        logDecision(categoryDecision.reasonCode || "SKIP_CATEGORY_SPORTS", trade, {
          tokenID: tokenId,
          marketTitle: categoryDecision.title,
          categories: categoryDecision.categories,
          matched: categoryDecision.matched,
          matchSource: categoryDecision.matchSource,
          strict: strictMarket,
        });
        return { status: "skipped", reason: categoryDecision.reason || "market category disallowed" };
      }

      const isClosed = Boolean(market?.closed);
      const isArchived = Boolean(market?.archived);
      const isActive = market?.active;
      if (isClosed || isArchived || isActive === false) {
        logDecision("SKIP_MARKET_CLOSED", trade, {
          tokenID: tokenId,
          marketTitle,
          closed: isClosed,
          archived: isArchived,
          active: isActive,
          strict: strictMarket,
        });
        return { status: "skipped", reason: "market closed/inactive" };
      }

      const gammaEnd = parseMarketEndMs(market, ["endDateIso", "end_date_iso", "endDate", "end_date"]);
      let endMs = gammaEnd.endMs;
      let endSource = gammaEnd.source ? `gamma:${gammaEnd.source}` : "gamma";
      let endRaw = gammaEnd.raw;
      let endNormalized = gammaEnd.normalized;

      if (!endMs) {
        try {
          const clobMarket = await publicClient.getMarket(trade.conditionId);
          const clobEnd = parseMarketEndMs(clobMarket);
          if (clobEnd.endMs) {
            endMs = clobEnd.endMs;
            endSource = clobEnd.source ? `clob:${clobEnd.source}` : "clob";
            endRaw = clobEnd.raw;
            endNormalized = clobEnd.normalized;
          }
        } catch (err) {
          const info = extractErrorInfo(err);
          logger.debug("clob market lookup failed", {
            conditionId: trade.conditionId,
            tokenID: tokenId,
            error: info.message,
            status: info.status,
          });
        }
      }

      if (!endMs) {
        logDecision("SKIP_MARKET_END_UNKNOWN", trade, {
          tokenID: tokenId,
          marketTitle,
          marketEndSource: endSource,
          marketEndRaw: endRaw,
          marketEndNormalized: endNormalized,
          closed: isClosed,
          active: isActive,
          strict: strictMarket,
        });
        return { status: "skipped", reason: "missing market end time" };
      }

      const nowMs = Date.now();
      const safetyMs = config.marketEndSafetySeconds * 1000;
      if (nowMs >= endMs - safetyMs) {
        const remainingMs = endMs - nowMs;
        logger.debug("market expiry check", {
          tokenID: tokenId,
          conditionId: trade.conditionId,
          marketTitle,
          marketEndSource: endSource,
          marketEndRaw: endRaw,
          marketEndNormalized: endNormalized,
          marketEndMs: endMs,
          marketEndIso: new Date(endMs).toISOString(),
          nowMs,
          remainingMs,
          marketEndSafetyMs: safetyMs,
        });
        logExpiredDecision(trade, {
          tokenID: tokenId,
          marketTitle,
          nowMs,
          marketEndMs: endMs,
          safetyMs,
        });
        return { status: "skipped", reason: "market expired/too close to end" };
      }

      const maxTtlSeconds = Math.floor((endMs - nowMs) / 1000) - config.expirationSafetySeconds;
      const ttlSeconds = Math.min(config.orderTtlSeconds, maxTtlSeconds);
      if (ttlSeconds <= 1) {
        logDecision("SKIP_ORDER_TTL_CROSSES_END", trade, {
          tokenID: tokenId,
          marketTitle,
          nowMs,
          marketEndMs: endMs,
          safetyMs,
          ttlSeconds,
        });
        return { status: "skipped", reason: "order TTL crosses market end" };
      }
      buyOrderTtlSeconds = ttlSeconds;
    } catch (err) {
      const info = extractErrorInfo(err);
      logDecision("SKIP_MARKET_METADATA_UNAVAILABLE", trade, {
        tokenID: tokenId,
        error: info.message,
        status: info.status,
      });
      return { status: "skipped", reason: "market metadata unavailable" };
    }
  } else {
    try {
      const { market: fetchedMarket, strict } = await getMarketByConditionId(trade.conditionId);
      market = fetchedMarket;
      strictMarket = strict;
    } catch (err) {
      const info = extractErrorInfo(err);
      logDecision("SKIP_MARKET_METADATA_UNAVAILABLE", trade, {
        tokenID: tokenId,
        error: info.message,
        status: info.status,
      });
      return { status: "skipped", reason: "market metadata unavailable" };
    }

    if (!market) {
      logDecision("SKIP_MARKET_METADATA_UNAVAILABLE", trade, {
        tokenID: tokenId,
        strict: strictMarket,
      });
      return { status: "skipped", reason: "market metadata unavailable" };
    }

    marketTitle = extractMarketTitle(market);
    const categoryDecision = evaluateMarketCategory(market, config);
    if (!categoryDecision.allowed) {
      logDecision(categoryDecision.reasonCode || "SKIP_CATEGORY_SPORTS", trade, {
        tokenID: tokenId,
        marketTitle: categoryDecision.title,
        categories: categoryDecision.categories,
        matched: categoryDecision.matched,
        matchSource: categoryDecision.matchSource,
        strict: strictMarket,
      });
      return { status: "skipped", reason: categoryDecision.reason || "market category disallowed" };
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
    logDecision("SKIP_INVALID_EXEC_PRICE", trade, {
      tokenID: tokenId,
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
    logDecision("SKIP_INVALID_TRADE_NOTIONAL", trade, {
      tokenID: tokenId,
      tradeNotional,
    });
    return { status: "skipped", reason: "invalid trade notional" };
  }

  if (weight <= 0) {
    logDecision("SKIP_NON_POSITIVE_WEIGHT", trade, { tokenID: tokenId, weight });
    return { status: "skipped", reason: "non-positive weight" };
  }

  const desiredNotional = Math.min(tradeNotional * config.copyRatio * weight, config.maxUsdcPerTrade);
  if (desiredNotional <= 0) {
    logDecision("SKIP_NON_POSITIVE_NOTIONAL", trade, {
      tokenID: tokenId,
      desiredNotional,
    });
    return { status: "skipped", reason: "non-positive desired notional" };
  }
  if (Number.isFinite(config.maxDailyUsdc)) {
    const dateKey = todayKey();
    const spent = state.getDailyNotional(dateKey);
    if (spent + desiredNotional > config.maxDailyUsdc) {
      logDecision("SKIP_DAILY_CAP", trade, {
        tokenID: tokenId,
        spent,
        desiredNotional,
        maxDailyUsdc: config.maxDailyUsdc,
      });
      return { status: "skipped", reason: "daily cap reached" };
    }
  }

  let shares = desiredNotional / execPrice;
  shares = Math.min(shares, config.maxSharesPerTrade);

  if (trade.side === "SELL") {
    const positionsUser = getPositionsUserAddress(config);
    const positions = await fetchPositions(positionsUser, trade.conditionId);
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
    logDecision("SKIP_MIN_SIZE", trade, {
      tokenID: tokenId,
      shares,
      minOrderSize,
    });
    return { status: "skipped", reason: "size below min" };
  }

  const limitPriceRaw =
    trade.side === "BUY"
      ? execPrice * (1 + config.slippagePct)
      : execPrice * (1 - config.slippagePct);
  const limitPrice = roundPriceToTick(limitPriceRaw, meta.tickSize, trade.side);
  if (limitPrice <= 0) {
    logDecision("SKIP_INVALID_LIMIT_PRICE", trade, {
      tokenID: tokenId,
      limitPriceRaw,
    });
    return { status: "skipped", reason: "invalid limit price" };
  }

  const notional = shares * limitPrice;
  if (Number.isFinite(config.maxDailyUsdc)) {
    const dateKey = todayKey();
    const spent = state.getDailyNotional(dateKey);
    if (spent + notional > config.maxDailyUsdc) {
      logDecision("SKIP_DAILY_CAP", trade, {
        tokenID: tokenId,
        spent,
        notional,
        maxDailyUsdc: config.maxDailyUsdc,
      });
      return { status: "skipped", reason: "daily cap reached" };
    }
  }

  if (trade.side === "BUY" && !config.dryRun && tradingClient && allowanceManager) {
    try {
      const allowanceStatus = await allowanceManager.ensureAllowance({
        reason: "pre-trade",
        requiredNotionalUsdc: notional,
      });
      if (!allowanceStatus.ok) {
        logDecision("SKIP_ALLOWANCE_LOW", trade, {
          tokenID: tokenId,
          owner: allowanceStatus.owner,
          allowance: formatUsdcMicro(allowanceStatus.allowanceMicro),
          required: formatUsdcMicro(allowanceStatus.requiredMicro),
          reason: allowanceStatus.reason,
        });
        return { status: "skipped", reason: "allowance too low" };
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      logDecision("SKIP_PREFLIGHT_ERROR", trade, {
        tokenID: tokenId,
        error: info.message,
        status: info.status,
      });
      return { status: "skipped", reason: "allowance check failed" };
    }
  }

  if (trade.side === "BUY" && !config.dryRun && tradingClient) {
    const preflight = await tradingPreflight(tradingClient, config, notional);
    if (!preflight.ok) {
      logDecision(preflight.reasonCode, trade, preflight.context);
      return { status: "skipped", reason: preflight.reason };
    }
  }

  if (config.dryRun || !tradingClient) {
    state.addDailyNotional(todayKey(), notional);
    return { status: "dry_run", reason: "dry run", notional, size: shares, limitPrice };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds =
    trade.side === "BUY" && buyOrderTtlSeconds !== null ? buyOrderTtlSeconds : config.orderTtlSeconds;
  const expiration = computeGtdExpirationSeconds(
    nowSeconds,
    ttlSeconds,
    config.expirationSafetySeconds
  );
  const userOrder: UserOrder = {
    tokenID: tokenId,
    price: limitPrice,
    size: shares,
    side: trade.side === "BUY" ? Side.BUY : Side.SELL,
    expiration,
  };
  const orderOptions = {
    tickSize: meta.tickSize as any,
    negRisk: meta.negRisk,
  };
  const userOrderNoExp: UserOrder = {
    tokenID: tokenId,
    price: limitPrice,
    size: shares,
    side: trade.side === "BUY" ? Side.BUY : Side.SELL,
  };

  const attemptOrder = async (order: UserOrder, orderType: LimitOrderType) => {
    try {
      const resp = await createAndPostWithRetry(tradingClient, order, orderOptions, orderType);
      return { resp };
    } catch (err) {
      return { error: extractErrorInfo(err) };
    }
  };

  let attempt = await attemptOrder(userOrder, OrderType.GTD);
  if (attempt.error && isExpirationError(attempt.error.message)) {
    logger.warn("GTD order failed, falling back to GTC", { error: attempt.error.message });
    attempt = await attemptOrder(userOrderNoExp, OrderType.GTC);
  } else if (attempt.resp?.success === false) {
    const message = extractResponseMessage(attempt.resp) || "CLOB rejected order";
    if (isExpirationError(message)) {
      logger.warn("GTD order rejected due to expiration, falling back to GTC", { error: message });
      attempt = await attemptOrder(userOrderNoExp, OrderType.GTC);
    }
  }

  if (attempt.error) {
    if (isAuthError(attempt.error)) {
      markAuthFailure(attempt.error.message, attempt.error.status);
    }
    maybeTriggerBalanceCooldown(config, attempt.error.message);
    logCriticalOrderError(attempt.error.message, {
      tokenID: tokenId,
      conditionId: trade.conditionId,
      outcomeIndex: trade.outcomeIndex,
      side: trade.side,
    });
    const diagnostics = isBalanceOrAllowanceError(attempt.error.message) ? getPreflightDiagnostics() : undefined;
    return {
      status: "failed",
      reason: isAuthError(attempt.error) ? "auth failed" : "order failed",
      errorMessage: attempt.error.message,
      errorStatus: attempt.error.status,
      errorResponse: attempt.error.body,
      errorDiagnostics: diagnostics,
    };
  }

  const resp = attempt.resp;
  const orderId = resp?.orderID ?? resp?.orderId ?? resp?.id;
  if (resp?.success === false) {
    const message = extractResponseMessage(resp) || "CLOB rejected order";
    const status = extractResponseStatus(resp);
    if (isAuthError({ message, status })) {
      markAuthFailure(message, status);
    }
    maybeTriggerBalanceCooldown(config, message);
    logCriticalOrderError(message, {
      tokenID: tokenId,
      conditionId: trade.conditionId,
      outcomeIndex: trade.outcomeIndex,
      side: trade.side,
    });
    const diagnostics = isBalanceOrAllowanceError(message) ? getPreflightDiagnostics() : undefined;
    return {
      status: "failed",
      reason: "order rejected",
      errorMessage: message,
      errorStatus: status,
      errorResponse: resp,
      errorDiagnostics: diagnostics,
    };
  }

  state.addDailyNotional(todayKey(), notional);
  return { status: "placed", reason: "order placed", orderId, notional, size: shares, limitPrice };
}
