import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { Config, OrderBookMeta } from "./types";
import { StateStore } from "./state";
import { logger } from "./logger";

const META_TTL_MS = 5 * 60 * 1000;
const API_KEY_RETRY_DELAYS_MS = [1000, 2000, 4000];

export async function initClobClients(config: Config): Promise<{
  publicClient: ClobClient;
  tradingClient?: ClobClient;
}> {
  const publicClient = new ClobClient(config.clobHost, config.chainId);

  if (config.dryRun) {
    return { publicClient };
  }

  const signer = new Wallet(config.privateKey as string);
  const creds = await createOrDeriveApiKeyWithRetry(config, signer);
  const tradingClient = new ClobClient(
    config.clobHost,
    config.chainId,
    signer,
    creds,
    config.signatureType as any,
    config.funderAddress
  );

  return { publicClient, tradingClient };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createOrDeriveApiKeyWithRetry(config: Config, signer: Wallet) {
  const client = new ClobClient(config.clobHost, config.chainId, signer);
  let lastError: unknown;

  for (let attempt = 0; attempt < API_KEY_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      return await client.createOrDeriveApiKey();
    } catch (err) {
      lastError = err;
      const info = extractErrorInfo(err);
      logger.error("createOrDeriveApiKey failed", {
        status: info.status,
        error: info.message,
        response: info.body,
        attempt: attempt + 1,
      });
      logger.warn(
        "If you see intermittent auth failures, ensure your computer time is set automatically and synced."
      );
      if (attempt < API_KEY_RETRY_DELAYS_MS.length) {
        await sleep(API_KEY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  throw lastError;
}

function toNumber(value: unknown): number {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
}

export async function getOrderbookMeta(
  tokenId: string,
  client: ClobClient,
  state: StateStore
): Promise<OrderBookMeta> {
  const cached = state.getTokenMeta(tokenId);
  const now = Date.now();
  if (cached && now - cached.updatedAtMs < META_TTL_MS) return cached;

  let book: any;
  try {
    book = await client.getOrderBook(tokenId);
  } catch (err) {
    logClobError("getOrderBook", tokenId, undefined, err);
    throw err;
  }
  const meta: OrderBookMeta = {
    tokenId,
    tickSize: String(book.tick_size),
    minOrderSize: String(book.min_order_size),
    negRisk: Boolean(book.neg_risk),
    updatedAtMs: now,
  };
  state.setTokenMeta(meta);
  return meta;
}

function countDecimals(value: string): number {
  const idx = value.indexOf(".");
  return idx === -1 ? 0 : value.length - idx - 1;
}

export function roundPriceToTick(price: number, tickSize: string, side: "BUY" | "SELL"): number {
  const tick = toNumber(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const ticks = price / tick;
  const rounded = side === "BUY" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  const value = rounded * tick;
  return Number(value.toFixed(countDecimals(tickSize)));
}

function parseOrderbookLevel(entry: unknown): { price: number; size: number } | null {
  if (Array.isArray(entry) && entry.length >= 2) {
    const price = toNumber(entry[0]);
    const size = toNumber(entry[1]);
    if (Number.isFinite(price) && Number.isFinite(size)) return { price, size };
    return null;
  }
  if (entry && typeof entry === "object") {
    const price = toNumber((entry as any).price);
    const size = toNumber((entry as any).size);
    if (Number.isFinite(price) && Number.isFinite(size)) return { price, size };
  }
  return null;
}

function parseOrderbookLevels(entries: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(entries)) return [];
  const levels: Array<{ price: number; size: number }> = [];
  for (const entry of entries) {
    const parsed = parseOrderbookLevel(entry);
    if (parsed) levels.push(parsed);
  }
  return levels;
}

function extractErrorInfo(err: unknown): { message: string; status?: number | string; body?: unknown } {
  const anyErr = err as any;
  const message = anyErr?.message || "unknown error";
  const status = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.code;
  const body = anyErr?.response?.data ?? anyErr?.data;
  return { message, status, body };
}

function logClobError(operation: string, tokenId: string, side: string | undefined, err: unknown) {
  const info = extractErrorInfo(err);
  logger.error("clob call failed", {
    operation,
    tokenId,
    side,
    status: info.status,
    error: info.message,
    response: info.body,
  });
}

function parsePriceFromResponse(raw: unknown): number {
  const candidates = [
    raw,
    (raw as any)?.price,
    (raw as any)?.data?.price,
    (raw as any)?.data?.[0]?.price,
    (raw as any)?.result?.price,
    (raw as any)?.result,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return NaN;
}

export async function getExecutablePriceFromBook(
  client: ClobClient,
  tokenId: string,
  side: Side
): Promise<{ price: number; source: "book"; top?: any; error?: string }> {
  try {
    const book = await client.getOrderBook(tokenId);
    const bids = parseOrderbookLevels(book?.bids);
    const asks = parseOrderbookLevels(book?.asks);

    let best: { price: number; size: number } | null = null;
    if (side === Side.BUY) {
      for (const level of asks) {
        if (level.price <= 0) continue;
        if (!best || level.price < best.price) best = level;
      }
    } else {
      for (const level of bids) {
        if (level.price <= 0) continue;
        if (!best || level.price > best.price) best = level;
      }
    }

    const top = {
      side,
      bestPrice: best?.price,
      bestSize: best?.size,
      bidCount: bids.length,
      askCount: asks.length,
    };

    return { price: best?.price ?? NaN, source: "book", top };
  } catch (err) {
    logClobError("getOrderBook", tokenId, side, err);
    return { price: NaN, source: "book", error: extractErrorInfo(err).message };
  }
}

export async function getExecutablePriceFromGetPrice(
  client: ClobClient,
  tokenId: string,
  side: Side
): Promise<{ price: number; source: "getPrice"; raw?: unknown; error?: string }> {
  try {
    const raw = await client.getPrice(tokenId, side);
    const price = parsePriceFromResponse(raw);
    if (!Number.isFinite(price)) {
      logger.debug("unexpected getPrice response", { tokenId, side, raw });
    }
    return { price, source: "getPrice", raw };
  } catch (err) {
    logClobError("getPrice", tokenId, side, err);
    return { price: NaN, source: "getPrice", error: extractErrorInfo(err).message };
  }
}

export function computeGtdExpirationSeconds(nowSeconds: number, ttlSeconds: number, safetySeconds: number): number {
  const base = Math.max(0, Math.floor(nowSeconds));
  const ttl = Math.max(0, Math.floor(ttlSeconds));
  const safety = Math.max(0, Math.floor(safetySeconds));
  const minExpiration = base + safety + 1;
  const candidate = base + safety + ttl;
  return Math.max(minExpiration, candidate);
}

export async function getExecutablePrice(client: ClobClient, tokenId: string, side: "BUY" | "SELL"): Promise<number> {
  const result = await getExecutablePriceFromGetPrice(client, tokenId, side as Side);
  return result.price;
}
