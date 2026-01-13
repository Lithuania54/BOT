import assert from "assert";
import { isSportsTitle } from "../src/marketFilter";
import { isAllowanceSufficient } from "../src/allowance";
import { parseUsdcToMicro } from "../src/preflight";

assert.strictEqual(isSportsTitle("Barcelona vs Real Madrid"), true, "detects vs pattern");
assert.strictEqual(isSportsTitle("Over/Under 2.5 goals"), true, "detects over/under");
assert.strictEqual(isSportsTitle("Will BTC break $100k by 2025?"), false, "non-sports title allowed");

const minAllowance = 50;
assert.strictEqual(
  isAllowanceSufficient(parseUsdcToMicro("49"), undefined, minAllowance),
  false,
  "below min allowance"
);
assert.strictEqual(
  isAllowanceSufficient(parseUsdcToMicro("50"), undefined, minAllowance),
  true,
  "meets min allowance"
);
assert.strictEqual(
  isAllowanceSufficient(parseUsdcToMicro("70"), 80, minAllowance),
  false,
  "required notional exceeds allowance"
);
assert.strictEqual(
  isAllowanceSufficient(parseUsdcToMicro("80"), 70, minAllowance),
  true,
  "allowance exceeds required notional"
);

console.log("market filter + allowance tests passed");
