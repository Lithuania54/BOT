export type FollowMode = "LEADER" | "TOPK";

export interface Config {
  targets: string[];
  followMode: FollowMode;
  topK: number;
  lookbackDays: number;
  minClosedSample: number;
  evalIntervalMs: number;
  minHoldMs: number;
  switchMarginPct: number;
  stopScore: number;
  stopRealizedPnl: number;
  cooldownMs: number;
  copyRatio: number;
  maxUsdcPerTrade: number;
  maxSharesPerTrade: number;
  slippagePct: number;
  pollMs: number;
  dryRun: boolean;
  privateKey?: string;
  chainId: number;
  clobHost: string;
  myUserAddress: string;
  signatureType: number;
  funderAddress?: string;
  maxDailyUsdc: number;
  openPnlPenaltyFactor: number;
  orderTtlSeconds: number;
  expirationSafetySeconds: number;
  marketEndSafetySeconds: number;
  balanceErrorCooldownMs: number;
  noOrderLivenessMs: number;
  autoApprove: boolean;
  allowanceThresholdUsdc: number;
  autoRedeemEnabled: boolean;
  redeemPollMs: number;
  redeemCooldownMs: number;
  mirrorCursorFile: string;
  mirrorBootstrapLookbackMs: number;
  startFromNow: boolean;
  rpcUrl?: string;
  polyApiKey?: string;
  polyApiSecret?: string;
  polyApiPassphrase?: string;
  forceDeriveApiKey: boolean;
  apiKeyNonceFile: string;
  apiKeyFile: string;
}

export interface ResolvedTarget {
  target: string;
  displayName: string;
  proxyWallet: string;
}

export interface Trade {
  proxyWallet: string;
  transactionHash: string;
  conditionId: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  sizeRaw: string;
  priceRaw: string;
  timestampMs: number;
}

export interface Position {
  conditionId: string;
  outcomeIndex: number;
  size: number;
  cashPnl?: number;
  percentPnl?: number;
}

export interface ClosedPosition {
  realizedPnl: number;
  totalBought: number;
  timestampMs: number;
}

export interface TraderScore {
  proxyWallet: string;
  displayName: string;
  roi: number;
  realizedPnlSum: number;
  totalBoughtSum: number;
  sample: number;
  openPnlSum: number;
  score: number;
  eligible: boolean;
  timestampMs: number;
}

export interface LeaderSelection {
  mode: FollowMode;
  leader?: TraderScore;
  leaders: Array<{
    proxyWallet: string;
    displayName: string;
    score: number;
    weight: number;
  }>;
  reason: string;
  meta?: Record<string, unknown>;
}

export interface OrderBookMeta {
  tokenId: string;
  tickSize: string;
  minOrderSize: string;
  negRisk: boolean;
  updatedAtMs: number;
}

export interface MirrorResult {
  status: "placed" | "skipped" | "dry_run" | "failed";
  reason: string;
  orderId?: string;
  notional?: number;
  size?: number;
  limitPrice?: number;
  errorMessage?: string;
  errorStatus?: number | string;
  errorResponse?: unknown;
  errorDiagnostics?: Record<string, unknown>;
}
