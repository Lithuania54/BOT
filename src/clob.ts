import { ApiKeyCreds, ClobClient, Side } from "@polymarket/clob-client";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { Wallet } from "@ethersproject/wallet";
import { Config, OrderBookMeta } from "./types";
import { StateStore } from "./state";
import { logger } from "./logger";

const META_TTL_MS = 5 * 60 * 1000;
const API_KEY_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const API_KEY_BACKGROUND_RETRY_MS = 2 * 60 * 1000;
const API_KEY_CREDS_PERMS = 0o600;

type ApiKeySource = "env" | "file" | "created";
type ApiKeyResult = { creds: ApiKeyCreds; source: ApiKeySource };

function resolveFunderAddress(config: Config): string | undefined {
  if (config.signatureType === 1 || config.signatureType === 2) {
    return config.funderAddress;
  }
  return undefined;
}

export async function initClobClients(config: Config): Promise<{
  publicClient: ClobClient;
  tradingClient?: ClobClient;
  startTradingClientRetry?: (onReady: (client: ClobClient) => void) => void;
  apiKeySource?: ApiKeySource;
}> {
  const publicClient = new ClobClient(config.clobHost, config.chainId);

  if (config.dryRun) {
    return { publicClient };
  }

  const signer = new Wallet(config.privateKey as string);
  const apiKeyResult = await createOrDeriveApiKeyWithRetry(config, signer);
  let tradingClient: ClobClient | undefined;
  const funderAddress = resolveFunderAddress(config);
  tradingClient = new ClobClient(
    config.clobHost,
    config.chainId,
    signer,
    apiKeyResult.creds,
    config.signatureType as any,
    funderAddress
  );
  const signerAddress = await signer.getAddress();
  logger.info("identity summary", {
    derivedSignerAddress: signerAddress,
    signatureType: config.signatureType,
    funderAddress,
    apiKeySource: apiKeyResult.source,
  });

  const startTradingClientRetry = tradingClient
    ? undefined
    : (onReady: (client: ClobClient) => void) => {
        let running = false;
        const attempt = async () => {
          if (running) return;
          running = true;
          try {
            const nextCreds = await createOrDeriveApiKeyWithRetry(config, signer);
            const funderAddress = resolveFunderAddress(config);
            const nextClient = new ClobClient(
              config.clobHost,
              config.chainId,
              signer,
              nextCreds.creds,
              config.signatureType as any,
              funderAddress
            );
            onReady(nextClient);
            logger.info("API key creation recovered; trading client authenticated");
            clearInterval(timer);
          } finally {
            running = false;
          }
        };
        const timer = setInterval(() => {
          attempt().catch((err) =>
            logger.error("API key background retry failed", { error: extractErrorInfo(err).message })
          );
        }, API_KEY_BACKGROUND_RETRY_MS);
        attempt().catch((err) =>
          logger.error("API key background retry failed", { error: extractErrorInfo(err).message })
        );
      };

  return { publicClient, tradingClient, startTradingClientRetry, apiKeySource: apiKeyResult.source };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKeyCredsFromEnv(config: Config): ApiKeyCreds | null {
  if (config.polyApiKey && config.polyApiSecret && config.polyApiPassphrase) {
    return {
      key: config.polyApiKey,
      secret: config.polyApiSecret,
      passphrase: config.polyApiPassphrase,
    };
  }
  if (config.polyApiKey || config.polyApiSecret || config.polyApiPassphrase) {
    logger.warn("Partial POLY_API_* credentials provided; ignoring and attempting to derive API key.");
  }
  return null;
}

async function readApiKeyCredsFromFile(filePath: string): Promise<ApiKeyCreds | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.key && parsed?.secret && parsed?.passphrase) {
      return {
        key: String(parsed.key),
        secret: String(parsed.secret),
        passphrase: String(parsed.passphrase),
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeApiKeyCredsToFile(filePath: string, creds: ApiKeyCreds): Promise<void> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: API_KEY_CREDS_PERMS,
  });
}

async function loadOrCreateNonce(filePath: string): Promise<number> {
  const resolved = path.resolve(filePath);
  try {
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw);
    const nonce = Number(parsed?.nonce);
    if (Number.isFinite(nonce)) return nonce;
  } catch {
    // ignore and generate
  }
  const buffer = randomBytes(4);
  const nonce = buffer.readUInt32BE(0);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify({ nonce, createdAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: API_KEY_CREDS_PERMS,
  });
  return nonce;
}

async function createOrDeriveApiKeyWithRetry(config: Config, signer: Wallet): Promise<ApiKeyResult> {
  const envCreds = readApiKeyCredsFromEnv(config);
  if (envCreds && !config.forceDeriveApiKey) {
    logger.info("Using API key credentials from environment variables.", {
      myUserAddress: config.myUserAddress,
      funderAddress: config.funderAddress,
      signatureType: config.signatureType,
    });
    return { creds: envCreds, source: "env" };
  }

  if (!config.forceDeriveApiKey) {
    const fileCreds = await readApiKeyCredsFromFile(config.apiKeyFile);
    if (fileCreds) {
      logger.info("Using API key credentials from file.", {
        file: config.apiKeyFile,
        myUserAddress: config.myUserAddress,
        funderAddress: config.funderAddress,
        signatureType: config.signatureType,
      });
      return { creds: fileCreds, source: "file" };
    }
  }

  logger.info("Deriving API key", {
    myUserAddress: config.myUserAddress,
    funderAddress: config.funderAddress,
    signatureType: config.signatureType,
    forceDerive: config.forceDeriveApiKey,
  });

  const funderAddress = resolveFunderAddress(config);
  const client = new ClobClient(
    config.clobHost,
    config.chainId,
    signer,
    undefined,
    config.signatureType as any,
    funderAddress
  );
  let lastError: unknown;
  const nonce = await loadOrCreateNonce(config.apiKeyNonceFile);
  for (let attempt = 0; attempt < API_KEY_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      const creds = await client.createOrDeriveApiKey(nonce);
      await writeApiKeyCredsToFile(config.apiKeyFile, creds);
      return { creds, source: "created" };
    } catch (err) {
      lastError = err;
      const info = extractErrorInfo(err);
      logger.debug("createOrDeriveApiKey response", {
        status: info.status,
        response: info.body,
      });
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

  logger.error("createOrDeriveApiKey failed after retries", {
    error: extractErrorInfo(lastError).message,
  });
  throw new Error("API key creation failed; check POLY_ADDRESS/signer and FUNDER_ADDRESS settings.");
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
