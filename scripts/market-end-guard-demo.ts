const safetySeconds = 120;
const expirationSafetySeconds = 60;
const orderTtlSeconds = 60;

function parseMarketEndMs(market: any): number | null {
  const candidates = [
    market?.end_date_iso,
    market?.endDateIso,
    market?.end_date,
    market?.endDate,
    market?.closeTime,
    market?.close_time,
    market?.closedTime,
    market?.closed_time,
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

function shouldSkipBuy(market: any, nowMs: number) {
  const endMs = parseMarketEndMs(market);
  if (!endMs) {
    return { skip: true, reason: "missing market end time" };
  }
  const safetyMs = safetySeconds * 1000;
  if (nowMs >= endMs - safetyMs) {
    return { skip: true, reason: "market expired/too close to end" };
  }
  const maxTtlSeconds = Math.floor((endMs - nowMs) / 1000) - expirationSafetySeconds;
  const ttlSeconds = Math.min(orderTtlSeconds, maxTtlSeconds);
  if (ttlSeconds <= 1) {
    return { skip: true, reason: "order TTL crosses market end" };
  }
  return { skip: false, reason: "ok" };
}

const now = Date.now();
const fixtures = [
  {
    name: "expired",
    market: { end_date_iso: new Date(now - 10 * 60 * 1000).toISOString() },
  },
  {
    name: "missing_end",
    market: { question: "No end field" },
  },
  {
    name: "future_end",
    market: { end_date_iso: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
  },
];

for (const fixture of fixtures) {
  const result = shouldSkipBuy(fixture.market, now);
  console.log(fixture.name, result);
}
