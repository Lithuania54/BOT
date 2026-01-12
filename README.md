# Polymarket Adaptive Copy-Trading Bot

## Why the bot can stop buying
- Preflight checks fail (auth, funder/signature mismatch, balance/allowance, or collateral reserved in open orders).
- Market metadata is missing or indicates the market is closed/expired/too close to end.
- Safety limits are hit (min size, daily cap, max per-trade size, or balance cooldown after failures).

## How to interpret reason codes
- `SKIP_MISSING_REQUIRED_FIELDS`: trade row is missing required fields.
- `SKIP_INVALID_TOKEN_ID`: tokenID resolution looks wrong (conditionId-like or address).
- `SKIP_BALANCE_COOLDOWN`: cooldown triggered after balance/allowance failure.
- `SKIP_MARKET_METADATA_UNAVAILABLE`: Gamma market lookup failed or returned no data.
- `SKIP_MARKET_CLOSED`: Gamma says closed/archived/inactive.
- `SKIP_MARKET_END_UNKNOWN`: could not determine end time; BUY skipped for safety.
- `SKIP_MARKET_EXPIRED`: end time is past or too close for safety window.
- `SKIP_ORDER_TTL_CROSSES_END`: order TTL would extend past end time.
- `SKIP_INVALID_EXEC_PRICE`: order book empty or invalid executable price.
- `SKIP_INVALID_TRADE_NOTIONAL`: source trade notional <= 0.
- `SKIP_NON_POSITIVE_WEIGHT`: trader weight <= 0.
- `SKIP_NON_POSITIVE_NOTIONAL`: desired notional <= 0.
- `SKIP_DAILY_CAP`: daily notional cap reached.
- `SKIP_MIN_SIZE`: computed size below min order size.
- `SKIP_INVALID_LIMIT_PRICE`: computed limit price invalid.
- `SKIP_AUTH_FAIL`: CLOB auth failed (API key/secret/passphrase).
- `SKIP_INVALID_FUNDER`: missing/invalid funder for proxy signature.
- `SKIP_INVALID_SIGNATURE_TYPE`: signatureType is not 0/1/2.
- `SKIP_FUNDER_MISMATCH`: funder address does not match expected wallet.
- `SKIP_PREFLIGHT_ERROR`: preflight API call failed unexpectedly.
- `SKIP_ALLOWANCE_LOW`: allowance too low for desired notional.
- `SKIP_RESERVED_OPEN_ORDERS`: collateral reserved by open BUY orders.
- `SKIP_NO_AVAILABLE_COLLATERAL`: available USDCe is insufficient.

Order attempt outcomes:
- `status: "placed"`: order accepted by CLOB.
- `status: "failed"` with `reason: "order rejected"` or `reason: "order failed"`: inspect `errorResponse` and `errorDiagnostics` in logs.
