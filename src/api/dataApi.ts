import { fetchJson } from "./http";
import { ClosedPosition, Position, Trade } from "../types";
import { toMs } from "../utils/time";

const DATA_API_BASE = "https://data-api.polymarket.com";

function normalizeTimestamp(value: unknown): number | null {
  return toMs(value as any);
}

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

export function normalizeTrade(raw: any, proxyWallet: string): Trade | null {
  const conditionId = raw?.conditionId ?? raw?.condition_id ?? raw?.market ?? raw?.marketId;
  const outcomeIndex = asNumber(raw?.outcomeIndex ?? raw?.outcome_index ?? raw?.outcome);
  const sideRaw = String(raw?.side ?? raw?.takerSide ?? raw?.taker_side ?? "").toUpperCase();
  const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
  const sizeRaw = String(raw?.size ?? raw?.quantity ?? raw?.amount ?? raw?.shares ?? "0");
  const priceRaw = String(raw?.price ?? raw?.avgPrice ?? raw?.rate ?? "0");
  const size = asNumber(sizeRaw);
  const price = asNumber(priceRaw);
  const timestampRaw = raw?.timestamp ?? raw?.time ?? raw?.createdAt ?? raw?.created_at;
  const timestampMs = normalizeTimestamp(timestampRaw);
  const transactionHash = String(raw?.transactionHash ?? raw?.transaction_hash ?? raw?.txHash ?? "");

  if (!conditionId || !side || !Number.isFinite(outcomeIndex)) {
    return null;
  }
  if (!Number.isFinite(size) || !Number.isFinite(price)) {
    return null;
  }
  if (timestampMs === null) {
    return null;
  }

  return {
    proxyWallet,
    transactionHash,
    conditionId: String(conditionId),
    outcomeIndex,
    side,
    size,
    price,
    sizeRaw,
    priceRaw,
    timestampMs,
    timestampRaw: String(timestampRaw ?? ""),
  };
}

export async function fetchTrades(
  user: string,
  limit: number,
  offset: number,
  takerOnly = false
): Promise<any[]> {
  const params = new URLSearchParams({
    user,
    limit: String(limit),
    offset: String(offset),
    takerOnly: takerOnly ? "true" : "false",
  });
  const url = `${DATA_API_BASE}/trades?${params.toString()}`;
  const data = await fetchJson<any>(url);
  if (Array.isArray(data)) return data;
  return data?.data || data?.trades || [];
}

export async function fetchPositions(user: string, conditionId?: string): Promise<Position[]> {
  const params = new URLSearchParams({
    user,
    sizeThreshold: "0",
    limit: "500",
    offset: "0",
  });
  if (conditionId) params.set("market", conditionId);
  const url = `${DATA_API_BASE}/positions?${params.toString()}`;
  const data = await fetchJson<any>(url);
  const rows = Array.isArray(data) ? data : data?.data || data?.positions || [];
  return rows.map((row: any) => ({
    conditionId: String(row?.conditionId ?? row?.condition_id ?? row?.market ?? ""),
    outcomeIndex: asNumber(row?.outcomeIndex ?? row?.outcome_index ?? row?.outcome ?? 0),
    size: asNumber(row?.size ?? row?.position ?? 0),
    cashPnl: row?.cashPnl !== undefined ? asNumber(row?.cashPnl) : undefined,
    percentPnl: row?.percentPnl !== undefined ? asNumber(row?.percentPnl) : undefined,
  }));
}

export async function fetchClosedPositions(user: string): Promise<ClosedPosition[]> {
  const params = new URLSearchParams({
    user,
    limit: "50",
    offset: "0",
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  const url = `${DATA_API_BASE}/v1/closed-positions?${params.toString()}`;
  const data = await fetchJson<any>(url);
  const rows = Array.isArray(data) ? data : data?.data || data?.positions || [];
  return rows.map((row: any) => ({
    realizedPnl: asNumber(row?.realizedPnl ?? row?.realized_pnl ?? 0),
    totalBought: asNumber(row?.totalBought ?? row?.total_bought ?? 0),
    timestampMs: normalizeTimestamp(row?.timestamp ?? row?.time ?? row?.createdAt ?? row?.created_at) ?? 0,
  }));
}
