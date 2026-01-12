import { OpenOrder } from "@polymarket/clob-client";
import {
  calculateAvailableUsdcMicro,
  computeReservedUsdcMicro,
  formatUsdcMicro,
  parseUsdcToMicro,
} from "../src/preflight";

function assertEqual(actual: bigint, expected: bigint, label: string) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${formatUsdcMicro(expected)} but got ${formatUsdcMicro(actual)}`);
  }
}

const openOrders: OpenOrder[] = [
  {
    id: "order-1",
    status: "OPEN",
    owner: "0x0000000000000000000000000000000000000000",
    maker_address: "0x0000000000000000000000000000000000000000",
    market: "0xmarket",
    asset_id: "0xtoken",
    side: "BUY",
    original_size: "100",
    size_matched: "0",
    price: "0.5",
    associate_trades: [],
    outcome: "YES",
    created_at: 0,
    expiration: "0",
    order_type: "GTC",
  },
];

const reserved = computeReservedUsdcMicro(openOrders);
assertEqual(reserved, parseUsdcToMicro("50"), "reserved notional");

const balance = parseUsdcToMicro("100");
const allowance = parseUsdcToMicro("75");
const available = calculateAvailableUsdcMicro(balance, allowance, reserved);
assertEqual(available, parseUsdcToMicro("25"), "available balance after reserve");

console.log("preflight demo ok", {
  reserved: formatUsdcMicro(reserved),
  available: formatUsdcMicro(available),
});
