import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { Config, OrderBookMeta } from "./types";
import { StateStore } from "./state";

const META_TTL_MS = 5 * 60 * 1000;

export async function initClobClients(config: Config): Promise<{
  publicClient: ClobClient;
  tradingClient?: ClobClient;
}> {
  const publicClient = new ClobClient(config.clobHost, config.chainId);

  if (config.dryRun) {
    return { publicClient };
  }

  const signer = new Wallet(config.privateKey as string);
  const creds = await new ClobClient(config.clobHost, config.chainId, signer).createOrDeriveApiKey();
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

function toNumber(value: unknown): number {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

export async function getOrderbookMeta(
  tokenId: string,
  client: ClobClient,
  state: StateStore
): Promise<OrderBookMeta> {
  const cached = state.getTokenMeta(tokenId);
  const now = Date.now();
  if (cached && now - cached.updatedAtMs < META_TTL_MS) return cached;

  const book = await client.getOrderBook(tokenId);
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
  if (tick <= 0) return price;
  const ticks = price / tick;
  const rounded = side === "BUY" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  const value = rounded * tick;
  return Number(value.toFixed(countDecimals(tickSize)));
}

export async function getExecutablePrice(client: ClobClient, tokenId: string, side: "BUY" | "SELL"): Promise<number> {
  const price = await client.getPrice(tokenId, side);
  return toNumber(price);
}
