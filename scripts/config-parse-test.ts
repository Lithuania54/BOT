import assert from "assert";
import { normalizeEnvValue, parseMaxDailyUsdc } from "../src/config";

function expectThrow(fn: () => void, label: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true, `expected throw for ${label}`);
}

assert.strictEqual(parseMaxDailyUsdc(undefined), Number.POSITIVE_INFINITY, "missing MAX_DAILY_USDC -> Infinity");
assert.strictEqual(parseMaxDailyUsdc(""), Number.POSITIVE_INFINITY, "empty MAX_DAILY_USDC -> Infinity");
assert.strictEqual(parseMaxDailyUsdc("  \"100\" "), 100, "quoted MAX_DAILY_USDC parses");
expectThrow(() => parseMaxDailyUsdc("abc"), "invalid MAX_DAILY_USDC");

assert.strictEqual(normalizeEnvValue("  \"0xabc\" "), "0xabc", "normalize quotes");
assert.strictEqual(normalizeEnvValue("  'test' "), "test", "normalize single quotes");

console.log("config parse tests passed");
