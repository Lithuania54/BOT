# RUNBOOK

## If bot won't trade
- Check startup validation errors:
  - `MY_USER_ADDRESS (...) must match signer address (...) for SIGNATURE_TYPE=0`
  - `FUNDER_ADDRESS (...) must be different from signer address (...) for proxy/safe wallets`
  - `MY_USER_ADDRESS (...) must match FUNDER_ADDRESS (...) for proxy/safe wallets`
  - `PRIVATE_KEY must be a 32-byte hex string`
  - `CLOB_HOST is invalid` / `RPC_URL is invalid`
- Confirm selection is producing leaders:
  - Log line: `selection updated` with `reason` (e.g. `no-eligible-leader`, `min-hold-not-satisfied`, `stop-score-triggered`, `cooldown-active`, `topk-insufficient`)
  - If `sample size insufficient`, see `trader ineligible` logs.
- Inspect skip reasons on trades:
  - Log line: `trade skipped` with `reasonCode` (e.g. `SKIP_MARKET_EXPIRED`, `SKIP_MIN_SIZE`, `SKIP_DAILY_CAP`, `SKIP_ALLOWANCE_LOW`).
- Verify collateral status:
  - Log line: `balance smoke check` shows `balance` and `allowance`.
  - If you see `SKIP_RESERVED_OPEN_ORDERS`, cancel open BUY orders to free collateral.
- Look for promoted error logs:
  - `order failed: invalid signature`
  - `order failed: invalid funder address`
  - `order failed: insufficient balance or allowance`
  - `order failed: order expired`
- Liveness watchdog:
  - `liveness watchdog: signals received but no successful order` indicates orders are failing or blocked; check recent `trade skipped` and `order failed` logs immediately before it.
