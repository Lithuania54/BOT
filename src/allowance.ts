import { BigNumber, Contract, Wallet, constants } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Config } from "./types";
import { logger } from "./logger";
import { formatUsdcMicro, parseUsdcToMicro } from "./preflight";

export const USDC_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const CTF_SPENDER_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const WARNING_COOLDOWN_MS = 5 * 60 * 1000;
const APPROVAL_COOLDOWN_MS = 5 * 60 * 1000;

export interface AllowanceStatus {
  ok: boolean;
  owner: string;
  allowanceMicro: bigint;
  requiredMicro: bigint;
  approved: boolean;
  token: string;
  spender: string;
  reason?: string;
  txHash?: string;
}

export function getAllowanceOwner(config: Config): string {
  if (config.signatureType === 1 || config.signatureType === 2) {
    return config.funderAddress || config.myUserAddress;
  }
  return config.myUserAddress;
}

export function computeRequiredAllowanceMicro(
  requiredNotionalUsdc: number | undefined,
  minAllowanceUsdc: number
): bigint {
  const minMicro = parseUsdcToMicro(minAllowanceUsdc);
  let requiredMicro = 0n;
  if (Number.isFinite(requiredNotionalUsdc) && (requiredNotionalUsdc as number) > 0) {
    requiredMicro = parseUsdcToMicro((requiredNotionalUsdc as number).toFixed(6));
  }
  return requiredMicro > minMicro ? requiredMicro : minMicro;
}

export function isAllowanceSufficient(
  allowanceMicro: bigint,
  requiredNotionalUsdc: number | undefined,
  minAllowanceUsdc: number
): boolean {
  return allowanceMicro >= computeRequiredAllowanceMicro(requiredNotionalUsdc, minAllowanceUsdc);
}

function parseApproveAmount(raw: string): { amount: BigNumber; label: string } {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "max" || normalized === "maxuint256") {
    return { amount: constants.MaxUint256, label: "unlimited" };
  }
  const micro = parseUsdcToMicro(raw);
  if (micro <= 0n) {
    throw new Error(`APPROVE_AMOUNT_USDC must be > 0 or 'unlimited'. Got: ${raw}`);
  }
  return { amount: BigNumber.from(micro.toString()), label: formatUsdcMicro(micro) };
}

function isValidAddress(value: string | undefined): boolean {
  return Boolean(value && /^0x[0-9a-fA-F]{40}$/.test(value));
}

export class AllowanceManager {
  private readonly config: Config;
  private readonly provider?: JsonRpcProvider;
  private readonly token?: Contract;
  private signer?: Wallet;
  private inFlight: Promise<AllowanceStatus> | null = null;
  private lastWarningMs = 0;
  private lastApprovalMs = 0;

  constructor(config: Config) {
    this.config = config;
    if (config.rpcUrl) {
      this.provider = new JsonRpcProvider(config.rpcUrl);
      this.token = new Contract(USDC_TOKEN_ADDRESS, ERC20_ABI, this.provider);
    }
  }

  async ensureAllowance(options: {
    reason: "startup" | "interval" | "pre-trade";
    requiredNotionalUsdc?: number;
  }): Promise<AllowanceStatus> {
    const requiredMicro = computeRequiredAllowanceMicro(options.requiredNotionalUsdc, this.config.minAllowanceUsdc);
    if (this.inFlight) {
      const existing = await this.inFlight;
      if (existing.ok && existing.allowanceMicro >= requiredMicro) {
        return { ...existing, requiredMicro };
      }
    }
    this.inFlight = this.performCheck(options.reason, requiredMicro);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async performCheck(reason: string, requiredMicro: bigint): Promise<AllowanceStatus> {
    const owner = getAllowanceOwner(this.config);
    const statusBase = {
      owner,
      token: USDC_TOKEN_ADDRESS,
      spender: CTF_SPENDER_ADDRESS,
      requiredMicro,
    };
    try {
      if (this.config.dryRun) {
        return {
          ok: true,
          allowanceMicro: requiredMicro,
          approved: false,
          ...statusBase,
          reason: "dry run",
        };
      }

      if (!this.token || !this.provider) {
        this.logAllowanceWarningOnce("RPC_URL is required to check on-chain USDC allowance.", statusBase);
        return {
          ok: false,
          allowanceMicro: 0n,
          approved: false,
          ...statusBase,
          reason: "RPC_URL missing",
        };
      }

      let allowanceMicro = await this.fetchAllowance(owner);
      if (allowanceMicro >= requiredMicro) {
        return {
          ok: true,
          allowanceMicro,
          approved: false,
          ...statusBase,
        };
      }

      if (!this.config.autoApprove) {
        this.logApprovalRequiredOnce("AUTO_APPROVE disabled.", allowanceMicro, requiredMicro, owner, reason);
        return {
          ok: false,
          allowanceMicro,
          approved: false,
          ...statusBase,
          reason: "allowance too low",
        };
      }

      const autoApproveIssue = await this.validateAutoApprove(owner);
      if (autoApproveIssue) {
        this.logApprovalRequiredOnce(autoApproveIssue, allowanceMicro, requiredMicro, owner, reason);
        return {
          ok: false,
          allowanceMicro,
          approved: false,
          ...statusBase,
          reason: autoApproveIssue,
        };
      }

      const now = Date.now();
      if (now - this.lastApprovalMs < APPROVAL_COOLDOWN_MS) {
        return {
          ok: false,
          allowanceMicro,
          approved: false,
          ...statusBase,
          reason: "approval recently attempted",
        };
      }

      this.lastApprovalMs = now;
      const { amount, label } = parseApproveAmount(this.config.approveAmountUsdc);
      const signer = this.getSigner();
      if (!signer) {
        this.logApprovalRequiredOnce(
          "Signer unavailable for auto-approve.",
          allowanceMicro,
          requiredMicro,
          owner,
          reason
        );
        return {
          ok: false,
          allowanceMicro,
          approved: false,
          ...statusBase,
          reason: "signer unavailable",
        };
      }

      const tokenWithSigner = this.token.connect(signer);
      logger.info("submitting USDC approval", {
        token: USDC_TOKEN_ADDRESS,
        spender: CTF_SPENDER_ADDRESS,
        amount: label,
        owner,
      });

      const gasEstimate = await tokenWithSigner.estimateGas.approve(CTF_SPENDER_ADDRESS, amount);
      const feeData = await this.provider.getFeeData();
      const overrides: Record<string, unknown> = {
        gasLimit: gasEstimate.mul(120).div(100),
      };
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        overrides.maxFeePerGas = feeData.maxFeePerGas;
        overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else if (feeData.gasPrice) {
        overrides.gasPrice = feeData.gasPrice;
      }

      const tx = await tokenWithSigner.approve(CTF_SPENDER_ADDRESS, amount, overrides);
      logger.info("approval submitted", { hash: tx.hash, token: USDC_TOKEN_ADDRESS, spender: CTF_SPENDER_ADDRESS });
      const receipt = await tx.wait();
      logger.info("approval confirmed", {
        hash: receipt?.transactionHash,
        blockNumber: receipt?.blockNumber,
      });

      allowanceMicro = await this.fetchAllowance(owner);
      const ok = allowanceMicro >= requiredMicro;
      logger.info("allowance refreshed", {
        owner,
        allowance: formatUsdcMicro(allowanceMicro),
        required: formatUsdcMicro(requiredMicro),
        ok,
      });
      return {
        ok,
        allowanceMicro,
        approved: true,
        ...statusBase,
        txHash: receipt?.transactionHash,
        reason: ok ? undefined : "allowance still below requirement after approval",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logAllowanceWarningOnce("Allowance check failed.", {
        ...statusBase,
        error: message,
      });
      return {
        ok: false,
        allowanceMicro: 0n,
        approved: false,
        ...statusBase,
        reason: message,
      };
    }
  }

  private async fetchAllowance(owner: string): Promise<bigint> {
    const allowance = await this.token!.allowance(owner, CTF_SPENDER_ADDRESS);
    return BigInt(allowance.toString());
  }

  private async validateAutoApprove(owner: string): Promise<string | null> {
    if (this.config.signatureType !== 0) {
      return "AUTO_APPROVE only supported for SIGNATURE_TYPE=0 (EOA).";
    }
    if (!this.config.rpcUrl) {
      return "RPC_URL is missing for auto-approve.";
    }
    if (!this.config.privateKey) {
      return "PRIVATE_KEY is missing for auto-approve.";
    }
    if (!isValidAddress(owner)) {
      return "Allowance owner address is invalid.";
    }
    const signer = this.getSigner();
    if (!signer) {
      return "Signer unavailable for auto-approve.";
    }
    const signerAddress = (await signer.getAddress()).toLowerCase();
    if (signerAddress !== owner.toLowerCase()) {
      return "Signer does not match allowance owner.";
    }
    return null;
  }

  private getSigner(): Wallet | null {
    if (!this.signer && this.config.privateKey && this.provider) {
      this.signer = new Wallet(this.config.privateKey, this.provider);
    }
    return this.signer || null;
  }

  private logAllowanceWarningOnce(message: string, details: Record<string, unknown>) {
    const now = Date.now();
    if (now - this.lastWarningMs < WARNING_COOLDOWN_MS) return;
    this.lastWarningMs = now;
    logger.error(message, details);
  }

  private logApprovalRequiredOnce(
    reason: string,
    allowanceMicro: bigint,
    requiredMicro: bigint,
    owner: string,
    checkReason: string
  ) {
    const now = Date.now();
    if (now - this.lastWarningMs < WARNING_COOLDOWN_MS) return;
    this.lastWarningMs = now;
    logger.error("USDC allowance too low; approval required before trading", {
      reason,
      checkReason,
      owner,
      allowance: formatUsdcMicro(allowanceMicro),
      required: formatUsdcMicro(requiredMicro),
      token: USDC_TOKEN_ADDRESS,
      spender: CTF_SPENDER_ADDRESS,
      signatureType: this.config.signatureType,
    });
    logger.error(
      `Approve USDC spending for spender ${CTF_SPENDER_ADDRESS} on token ${USDC_TOKEN_ADDRESS} in Polymarket UI.`
    );
  }
}
