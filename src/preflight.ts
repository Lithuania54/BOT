import { OpenOrder } from "@polymarket/clob-client";

const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

function parseDecimalToFixed(value: string | number, decimals: number, roundUp: boolean): bigint {
  const raw = String(value).trim();
  if (!raw) return 0n;
  const match = raw.match(/^(-?\d+)(\.(\d+))?$/);
  if (!match) return 0n;
  const negative = match[1].startsWith("-");
  const wholeStr = negative ? match[1].slice(1) : match[1];
  const fracStr = match[3] || "";
  let frac = fracStr.slice(0, decimals).padEnd(decimals, "0");

  if (roundUp && fracStr.length > decimals && /[1-9]/.test(fracStr.slice(decimals))) {
    let carry = 1n;
    let fracNum = BigInt(frac || "0") + carry;
    if (fracNum >= 10n ** BigInt(decimals)) {
      fracNum -= 10n ** BigInt(decimals);
      carry = 1n;
    } else {
      carry = 0n;
    }
    frac = fracNum.toString().padStart(decimals, "0");
    const wholeNum = BigInt(wholeStr || "0") + carry;
    const combined = wholeNum * 10n ** BigInt(decimals) + BigInt(frac || "0");
    return negative ? -combined : combined;
  }

  const wholeNum = BigInt(wholeStr || "0");
  const combined = wholeNum * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return negative ? -combined : combined;
}

export function parseUsdcToMicro(value: string | number | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  return parseDecimalToFixed(value, USDC_DECIMALS, false);
}

function parseUsdcToMicroRoundedUp(value: string | number | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  return parseDecimalToFixed(value, USDC_DECIMALS, true);
}

export function formatUsdcMicro(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const result = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${result}` : result;
}

export function computeReservedUsdcMicro(openOrders: OpenOrder[]): bigint {
  let reserved = 0n;
  for (const order of openOrders) {
    if (!order || String(order.side).toUpperCase() !== "BUY") continue;
    const priceMicro = parseUsdcToMicroRoundedUp(order.price);
    const originalSize = parseUsdcToMicroRoundedUp(order.original_size);
    const matchedSize = parseUsdcToMicroRoundedUp(order.size_matched);
    const remaining = originalSize > matchedSize ? originalSize - matchedSize : 0n;
    if (remaining <= 0n || priceMicro <= 0n) continue;
    reserved += (priceMicro * remaining) / SCALE;
  }
  return reserved;
}

export function calculateAvailableUsdcMicro(balance: bigint, allowance: bigint, reserved: bigint): bigint {
  const spendable = balance < allowance ? balance : allowance;
  const available = spendable - reserved;
  return available > 0n ? available : 0n;
}
