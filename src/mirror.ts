import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Config, MirrorResult, Trade } from "./types";
import { StateStore } from "./state";
import { fetchPositions } from "./api/dataApi";
import { getClobTokenIdsForCondition } from "./api/gamma";
import { getExecutablePrice, getOrderbookMeta, roundDownToStep, roundPriceToTick } from "./clob";
import { logger } from "./logger";

function todayKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function mirrorTrade(
  trade: Trade,
  weight: number,
  config: Config,
  state: StateStore,
  publicClient: ClobClient,
  tradingClient?: ClobClient
): Promise<MirrorResult> {
  const tokenIds = await getClobTokenIdsForCondition(trade.conditionId, state);
  const tokenId = tokenIds[trade.outcomeIndex];
  if (!tokenId) {
    return { status: "skipped", reason: "missing tokenId" };
  }

  const meta = await getOrderbookMeta(tokenId, publicClient, state);
  const execPrice = await getExecutablePrice(publicClient, tokenId, trade.side);
  if (execPrice <= 0) {
    return { status: "skipped", reason: "invalid exec price" };
  }

  const tradeNotional = trade.price * trade.size;
  if (tradeNotional <= 0) {
    return { status: "skipped", reason: "invalid trade notional" };
  }

  const desiredNotional = Math.min(tradeNotional * config.copyRatio * weight, config.maxUsdcPerTrade);
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

  shares = roundDownToStep(shares, meta.minOrderSize);
  if (shares <= 0 || shares < Number(meta.minOrderSize)) {
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

  const expiration = Math.floor(Date.now() / 1000) + 60;
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
    return { status: "placed", reason: "order placed", orderId: resp?.orderID, notional, size: shares, limitPrice };
  } catch (err) {
    const message = (err as Error).message || "unknown error";
    if (message.toLowerCase().includes("gtd") || message.toLowerCase().includes("expiration")) {
      logger.warn("GTD order failed, falling back to GTC", { error: message });
      const userOrderNoExp = {
        tokenID: tokenId,
        price: limitPrice,
        size: shares,
        side: trade.side === "BUY" ? Side.BUY : Side.SELL,
      };
      const resp = await tradingClient.createAndPostOrder(userOrderNoExp, {
        tickSize: meta.tickSize as any,
        negRisk: meta.negRisk,
      }, OrderType.GTC);
      state.addDailyNotional(todayKey(), notional);
      return { status: "placed", reason: "order placed", orderId: resp?.orderID, notional, size: shares, limitPrice };
    }
    throw err;
  }
}
