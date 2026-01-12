import { fetchJson } from "./http";
import { ResolvedTarget } from "../types";
import { StateStore } from "../state";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

function extractAddress(target: string): string | null {
  const match = target.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0] : null;
}

function extractHandle(target: string): string | null {
  const urlMatch = target.match(/\/@([^/?#]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];
  return null;
}

export async function resolveTargetToProxyWallet(
  target: string,
  state: StateStore
): Promise<ResolvedTarget> {
  const cached = state.getResolvedTarget(target);
  if (cached) return cached;

  const address = extractAddress(target);
  if (address) {
    const resolved = { target, displayName: address, proxyWallet: address };
    state.setResolvedTarget(resolved);
    return resolved;
  }

  const handle = extractHandle(target) || target;
  const url = `${GAMMA_BASE}/public-search?${new URLSearchParams({
    q: handle,
    search_profiles: "true",
    limit_per_type: "5",
  }).toString()}`;
  const data = await fetchJson<any>(url);
  const profiles = data?.profiles || [];
  const proxyWallet = profiles[0]?.proxyWallet || profiles[0]?.proxy_wallet;
  if (!profiles.length || !proxyWallet) {
    throw new Error(`Unable to resolve target: ${target}`);
  }
  const resolved = {
    target,
    displayName: profiles[0]?.username || handle,
    proxyWallet,
  };
  state.setResolvedTarget(resolved);
  return resolved;
}

function parseClobTokenIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fallthrough
    }
    if (trimmed.includes(",")) return trimmed.split(",").map((v) => v.trim()).filter(Boolean);
    return [trimmed];
  }
  return [];
}

export async function getClobTokenIdsForCondition(
  conditionId: string,
  state: StateStore
): Promise<string[]> {
  const cached = state.getConditionTokenIds(conditionId);
  if (cached && cached.length) return cached;

  const url = `${GAMMA_BASE}/markets?${new URLSearchParams({
    condition_ids: conditionId,
    limit: "1",
    offset: "0",
  }).toString()}`;
  const data = await fetchJson<any>(url);
  const markets = Array.isArray(data) ? data : data?.markets || data?.data || [];
  const market = markets[0];
  const tokenIds = parseClobTokenIds(
    market?.clobTokenIds ?? market?.clob_token_ids ?? market?.clob_token_ids
  );
  if (!tokenIds.length) {
    throw new Error(`No token IDs for condition ${conditionId}`);
  }
  state.setConditionTokenIds(conditionId, tokenIds);
  return tokenIds;
}

export async function getMarketByConditionId(conditionId: string): Promise<any | null> {
  const url = `${GAMMA_BASE}/markets?${new URLSearchParams({
    condition_ids: conditionId,
    limit: "1",
    offset: "0",
  }).toString()}`;
  const data = await fetchJson<any>(url);
  const markets = Array.isArray(data) ? data : data?.markets || data?.data || [];
  return markets[0] || null;
}
