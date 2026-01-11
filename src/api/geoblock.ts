import { fetchJson } from "./http";

const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";

export interface GeoblockResult {
  blocked: boolean;
  reason?: string;
}

export async function checkGeoblock(): Promise<GeoblockResult> {
  const data = await fetchJson<any>(GEOBLOCK_URL, { timeoutMs: 8000 });
  if (typeof data === "boolean") {
    return { blocked: data };
  }

  const blocked = Boolean(data?.blocked ?? data?.geoBlocked ?? data?.geoblocked ?? false);
  const reason = data?.reason || data?.message || undefined;
  return { blocked, reason };
}
