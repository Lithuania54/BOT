import dotenv from "dotenv";
import { Config, FollowMode } from "./types";
import { logger } from "./logger";

dotenv.config();

const DEFAULT_TARGETS = [
  "https://polymarket.com/@0xf247584e41117bbBe4Cc06E4d2C95741792a5216-1742469835200",
  "https://polymarket.com/@BoshBashBish",
  "https://polymarket.com/@distinct-baguette",
  "https://polymarket.com/@rwo",
  "https://polymarket.com/@SeriouslySirius",
  "https://polymarket.com/@swisstony",
  "https://polymarket.com/@LlamaEnjoyer",
  "https://polymarket.com/@kch123",
];

function parseNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`Missing ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function requireString(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing ${name}`);
  return raw;
}

function parseRpcUrl(): string | undefined {
  const raw = process.env.RPC_URL;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    logger.error("RPC_URL is invalid (contains whitespace). Auto-redeem will be disabled.", { rpcUrl: raw });
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Invalid protocol");
    }
    return trimmed;
  } catch {
    logger.error("RPC_URL is invalid (not a URL). Auto-redeem will be disabled.", { rpcUrl: raw });
    return undefined;
  }
}

export function loadConfig(): Config {
  const targetsRaw = process.env.TARGETS;
  const targets = targetsRaw
    ? targetsRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : DEFAULT_TARGETS;

  const followMode = (process.env.FOLLOW_MODE || "LEADER").toUpperCase() as FollowMode;
  if (followMode !== "LEADER" && followMode !== "TOPK") {
    throw new Error(`Invalid FOLLOW_MODE: ${followMode}`);
  }

  const dryRun = parseBoolean("DRY_RUN", true);

  const config: Config = {
    targets,
    followMode,
    topK: parseNumber("TOPK", 2),
    lookbackDays: parseNumber("LOOKBACK_DAYS", 30),
    minClosedSample: parseNumber("MIN_CLOSED_SAMPLE", 5),
    evalIntervalMs: parseNumber("EVAL_INTERVAL_MS", 600000),
    minHoldMs: parseNumber("MIN_HOLD_MS", 1800000),
    switchMarginPct: parseNumber("SWITCH_MARGIN_PCT", 0.1),
    stopScore: parseNumber("STOP_SCORE", -0.01),
    stopRealizedPnl: parseNumber("STOP_REALIZED_PNL", -10),
    cooldownMs: parseNumber("COOLDOWN_MS", 3600000),
    copyRatio: parseNumber("COPY_RATIO", 0.02),
    maxUsdcPerTrade: parseNumber("MAX_USDC_PER_TRADE", 50),
    maxSharesPerTrade: parseNumber("MAX_SHARES_PER_TRADE", 200),
    slippagePct: parseNumber("SLIPPAGE_PCT", 0.02),
    pollMs: parseNumber("POLL_MS", 4000),
    dryRun,
    privateKey: process.env.PRIVATE_KEY,
    chainId: parseNumber("CHAIN_ID", 137),
    clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
    myUserAddress: requireString("MY_USER_ADDRESS"),
    signatureType: parseNumber("SIGNATURE_TYPE", 1),
    funderAddress: process.env.FUNDER_ADDRESS,
    maxDailyUsdc: process.env.MAX_DAILY_USDC ? parseNumber("MAX_DAILY_USDC") : undefined,
    openPnlPenaltyFactor: parseNumber("OPEN_PNL_PENALTY_FACTOR", 0.25),
    orderTtlSeconds: parseNumber("ORDER_TTL_SECONDS", 60),
    expirationSafetySeconds: parseNumber("EXPIRATION_SAFETY_SECONDS", 60),
    marketEndSafetySeconds: parseNumber("MARKET_END_SAFETY_SECONDS", 120),
    autoRedeemEnabled: parseBoolean("AUTO_REDEEM_ENABLED", false),
    redeemPollMs: parseNumber("REDEEM_POLL_MS", 300000),
    redeemCooldownMs: parseNumber("REDEEM_COOLDOWN_MS", 3600000),
    rpcUrl: parseRpcUrl(),
  };

  if (!config.dryRun) {
    if (!config.privateKey) throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
    if (!config.funderAddress) throw new Error("FUNDER_ADDRESS is required when DRY_RUN=false");
  }

  return config;
}
