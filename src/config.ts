import dotenv from "dotenv";
import { Wallet } from "ethers";
import { Config, FollowMode } from "./types";
import { normalizeCategoryToken } from "./marketFilter";
import { logger } from "./logger";

dotenv.config();

const DEFAULT_TARGET_TRADER_WALLET = "0xf247584e41117bbbe4cc06e4d2c95741792a5216";

export function normalizeEnvValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (!value) return "";
  const hasSingle = value.startsWith("'") && value.endsWith("'");
  const hasDouble = value.startsWith("\"") && value.endsWith("\"");
  if ((hasSingle || hasDouble) && value.length >= 2) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function env(name: string): string | undefined {
  return normalizeEnvValue(process.env[name]);
}

function normalizeHex(raw: string | undefined): string | undefined {
  const value = normalizeEnvValue(raw);
  if (value === undefined) return undefined;
  if (value === "") return "";
  if (value.startsWith("0x") || value.startsWith("0X")) return value;
  return `0x${value}`;
}

function normalizeWalletAddress(raw: string | undefined): string {
  const value = normalizeHex(raw);
  if (!value) {
    throw new Error("COPY_TRADER_WALLET is required.");
  }
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`COPY_TRADER_WALLET must be a valid 0x address: ${value}`);
  }
  return normalized;
}

function extractAddress(value: string): string | null {
  const match = value.match(/0x[0-9a-fA-F]{40}/);
  return match ? match[0].toLowerCase() : null;
}

function parseNumber(name: string, fallback?: number): number {
  const raw = env(name);
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`Missing ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function parseNumberValue(name: string, raw: string): number {
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

function requireString(name: string): string {
  const raw = env(name);
  if (!raw) throw new Error(`Missing ${name}`);
  return raw;
}

export function parseMaxDailyUsdc(raw: string | undefined): number {
  const normalized = normalizeEnvValue(raw);
  if (normalized === undefined || normalized === "") return Number.POSITIVE_INFINITY;
  const value = Number(normalized);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid number for MAX_DAILY_USDC: ${normalized}`);
  }
  return value;
}

function parseMinAllowanceUsdc(): number {
  const raw = env("MIN_ALLOWANCE_USDC");
  if (raw !== undefined && raw !== "") {
    const value = parseNumberValue("MIN_ALLOWANCE_USDC", raw);
    if (value < 0) throw new Error(`MIN_ALLOWANCE_USDC must be >= 0. Got: ${raw}`);
    return value;
  }
  const legacy = env("ALLOWANCE_THRESHOLD_USDC");
  if (legacy !== undefined && legacy !== "") {
    const value = parseNumberValue("ALLOWANCE_THRESHOLD_USDC", legacy);
    if (value < 0) throw new Error(`ALLOWANCE_THRESHOLD_USDC must be >= 0. Got: ${legacy}`);
    return value;
  }
  return 50;
}

function parseApproveAmountUsdc(): string {
  const raw = env("APPROVE_AMOUNT_USDC");
  if (raw === undefined || raw === "") return "1000";
  const normalized = raw.trim();
  const lower = normalized.toLowerCase();
  if (lower === "unlimited" || lower === "max" || lower === "maxuint256") {
    return "unlimited";
  }
  const value = parseNumberValue("APPROVE_AMOUNT_USDC", normalized);
  if (value <= 0) {
    throw new Error(`APPROVE_AMOUNT_USDC must be > 0 or 'unlimited'. Got: ${normalized}`);
  }
  return normalized;
}

function parseCsvList(name: string, fallback: string[]): string[] {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((entry) => normalizeCategoryToken(entry))
    .filter(Boolean);
}

function parseUrlValue(name: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Invalid protocol");
    }
    return raw;
  } catch {
    throw new Error(`${name} is invalid: ${raw}`);
  }
}

function parseRpcUrl(): string | undefined {
  const raw = env("RPC_URL");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error(`RPC_URL is invalid (contains whitespace): ${raw}`);
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Invalid protocol");
    }
    return trimmed;
  } catch {
    throw new Error(`RPC_URL is invalid (not a URL): ${raw}`);
  }
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validateChainId(chainId: number) {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  }
}

function validateConfig(config: Config) {
  validateChainId(config.chainId);
  parseUrlValue("CLOB_HOST", config.clobHost);
  if (config.rpcUrl) {
    parseUrlValue("RPC_URL", config.rpcUrl);
  }

  if (config.targets.length !== 1) {
    throw new Error("Only one source wallet is supported at this time.");
  }
  if (config.targets[0].toLowerCase() !== config.targetTraderWallet) {
    throw new Error("TARGETS must match COPY_TRADER_WALLET.");
  }

  if (!isAddress(config.myUserAddress)) {
    throw new Error(`MY_USER_ADDRESS must be a valid 0x address: ${config.myUserAddress}`);
  }

  if (config.privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
      throw new Error("PRIVATE_KEY must be a 32-byte hex string (0x + 64 hex chars).");
    }
  } else if (!config.dryRun) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }

  if (config.funderAddress && !isAddress(config.funderAddress)) {
    throw new Error(`FUNDER_ADDRESS must be a valid 0x address: ${config.funderAddress}`);
  }

  if (config.signatureType !== 0 && config.signatureType !== 1 && config.signatureType !== 2) {
    throw new Error(`SIGNATURE_TYPE must be 0, 1, or 2. Got ${config.signatureType}`);
  }

  if (config.privateKey) {
    const signer = new Wallet(config.privateKey);
    const signerAddress = signer.address.toLowerCase();
    const myUserAddress = config.myUserAddress.toLowerCase();

    if (myUserAddress !== signerAddress) {
      throw new Error(
        `MY_USER_ADDRESS (${config.myUserAddress}) must match the signer EOA derived from PRIVATE_KEY (${signer.address}). ` +
          "Set MY_USER_ADDRESS to your wallet address; set FUNDER_ADDRESS to your Polymarket proxy wallet if using SIGNATURE_TYPE=1 or 2."
      );
    }

    if (config.signatureType === 0) {
      if (!config.funderAddress) {
        throw new Error(
          "FUNDER_ADDRESS is required for SIGNATURE_TYPE=0 and must match the signer EOA address."
        );
      }
      if (config.funderAddress.toLowerCase() !== signerAddress) {
        throw new Error(
          `FUNDER_ADDRESS (${config.funderAddress}) must match signer address (${signer.address}) for SIGNATURE_TYPE=0.`
        );
      }
    } else {
      if (!config.funderAddress) {
        throw new Error(
          "FUNDER_ADDRESS is required for SIGNATURE_TYPE=1 or 2. Use the proxy wallet address shown on polymarket.com."
        );
      }
      if (config.funderAddress.toLowerCase() === signerAddress) {
        throw new Error(
          `FUNDER_ADDRESS (${config.funderAddress}) must be different from signer address (${signer.address}) for proxy/safe wallets.`
        );
      }
    }
  } else {
    logger.warn("PRIVATE_KEY is missing; signer validation skipped.", {
      dryRun: config.dryRun,
      signatureType: config.signatureType,
    });
  }
}

export function loadConfig(): Config {
  const targetTraderWallet = normalizeWalletAddress(
    env("COPY_TRADER_WALLET") || env("TARGET_TRADER_WALLET") || DEFAULT_TARGET_TRADER_WALLET
  );
  const targetsRaw = env("TARGETS");
  const parsedTargets = targetsRaw
    ? targetsRaw.split(",").map((t) => normalizeEnvValue(t) || "").filter(Boolean)
    : [];
  if (parsedTargets.length > 1) {
    throw new Error("Only one TARGETS entry is supported. Use COPY_TRADER_WALLET for the single source wallet.");
  }
  if (parsedTargets.length === 1) {
    const embedded = extractAddress(parsedTargets[0]);
    if (embedded && embedded.toLowerCase() !== targetTraderWallet) {
      throw new Error(
        `TARGETS must reference the COPY_TRADER_WALLET (${targetTraderWallet}). Got ${parsedTargets[0]}`
      );
    }
    if (!embedded) {
      logger.warn("TARGETS provided without wallet address; using COPY_TRADER_WALLET instead.", {
        target: parsedTargets[0],
        copyTraderWallet: targetTraderWallet,
      });
    }
  }
  const targets = [targetTraderWallet];

  const followMode = (env("FOLLOW_MODE") || "LEADER").toUpperCase() as FollowMode;
  if (followMode !== "LEADER" && followMode !== "TOPK") {
    throw new Error(`Invalid FOLLOW_MODE: ${followMode}`);
  }

  const dryRun = parseBoolean("DRY_RUN", true);

  const config: Config = {
    targets,
    targetTraderWallet,
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
    privateKey: normalizeHex(process.env.PRIVATE_KEY),
    chainId: parseNumber("CHAIN_ID", 137),
    clobHost: parseUrlValue("CLOB_HOST", env("CLOB_HOST") || "https://clob.polymarket.com")!,
    myUserAddress: normalizeHex(requireString("MY_USER_ADDRESS"))!,
    signatureType: parseNumber("SIGNATURE_TYPE", 1),
    funderAddress: normalizeHex(process.env.FUNDER_ADDRESS),
    maxDailyUsdc: parseMaxDailyUsdc(process.env.MAX_DAILY_USDC),
    openPnlPenaltyFactor: parseNumber("OPEN_PNL_PENALTY_FACTOR", 0.25),
    orderTtlSeconds: parseNumber("ORDER_TTL_SECONDS", 60),
    expirationSafetySeconds: parseNumber("EXPIRATION_SAFETY_SECONDS", 60),
    marketEndSafetySeconds: parseNumber("MARKET_END_SAFETY_SECONDS", 300),
    balanceErrorCooldownMs: parseNumber("BALANCE_ERROR_COOLDOWN_MS", 900000),
    noOrderLivenessMs: parseNumber("NO_ORDER_LIVENESS_MS", 900000),
    autoApprove: parseBoolean("AUTO_APPROVE", false),
    approveAmountUsdc: parseApproveAmountUsdc(),
    minAllowanceUsdc: parseMinAllowanceUsdc(),
    allowedCategories: parseCsvList("ALLOWED_CATEGORIES", ["crypto", "finance", "politics", "tech", "other"]),
    disallowedCategories: parseCsvList("DISALLOWED_CATEGORIES", ["sports"]),
    autoRedeemEnabled: parseBoolean("AUTO_REDEEM_ENABLED", false),
    redeemPollMs: parseNumber("REDEEM_POLL_MS", 300000),
    redeemCooldownMs: parseNumber("REDEEM_COOLDOWN_MS", 3600000),
    mirrorCursorFile: env("MIRROR_CURSOR_FILE") || ".pm_mirror_cursor.json",
    mirrorBootstrapLookbackMs: parseNumber("MIRROR_BOOTSTRAP_LOOKBACK_MS", 60000),
    startFromNow: parseBoolean("START_FROM_NOW", false),
    rpcUrl: parseRpcUrl(),
    polyApiKey: env("POLY_API_KEY"),
    polyApiSecret: env("POLY_API_SECRET"),
    polyApiPassphrase: env("POLY_API_PASSPHRASE"),
    forceDeriveApiKey: parseBoolean("FORCE_DERIVE_API_KEY", false),
    apiKeyNonceFile: env("API_KEY_NONCE_FILE") || ".pm_api_nonce.json",
    apiKeyFile: env("POLY_API_KEY_FILE") || ".pm_api_creds.json",
  };

  if (!config.dryRun && !config.funderAddress) {
    throw new Error("FUNDER_ADDRESS is required when DRY_RUN=false");
  }

  validateConfig(config);

  return config;
}
