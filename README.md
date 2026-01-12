# Polymarket Adaptive Copy Trading Bot

Production-ready TypeScript bot that tracks a configurable set of Polymarket accounts, scores recent performance, selects the best leader(s) with hysteresis, and mirrors BUY/SELL trades into your account with smaller size and strict safety controls.

This project does **not** guarantee profit. It adapts based on historical/recent metrics and enforces risk controls to reduce exposure.

## Setup

1) Install dependencies

```bash
npm install
```

2) Copy and edit the environment file

```bash
copy .env.example .env
```

3) Run the bot

```bash
npm run start
```

## Configuration

All environment variables are parsed in `src/config.ts`.

- `TARGETS` CSV list of handles, profile URLs, or 0x addresses (defaults to the 8 provided)
- `FOLLOW_MODE` `LEADER` or `TOPK`
- `TOPK` number of traders to follow in `TOPK` mode
- `LOOKBACK_DAYS` scoring window for realized PnL
- `MIN_CLOSED_SAMPLE` minimum closed positions in window to be eligible
- `EVAL_INTERVAL_MS` how often to rescore all traders
- `MIN_HOLD_MS` minimum time to keep the current leader
- `SWITCH_MARGIN_PCT` required improvement to switch leaders
- `STOP_SCORE` stop-follow threshold for leader score
- `STOP_REALIZED_PNL` stop-follow threshold for realized PnL in window
- `COOLDOWN_MS` cooldown before switching back to a trader
- `COPY_RATIO` scaling factor for mirroring notional size
- `MAX_USDC_PER_TRADE` cap on mirrored notional per trade
- `MAX_SHARES_PER_TRADE` cap on mirrored shares per trade
- `SLIPPAGE_PCT` slippage buffer for limit orders
- `POLL_MS` trade poll interval
- `DRY_RUN` log actions without posting orders
- `PRIVATE_KEY` required when `DRY_RUN=false`
- `CHAIN_ID` default `137`
- `CLOB_HOST` default `https://clob.polymarket.com`
- `MY_USER_ADDRESS` profile address used for SELL clamp in `/positions`
- `SIGNATURE_TYPE` `0`, `1`, or `2`
- `FUNDER_ADDRESS` required when `DRY_RUN=false`
- `MAX_DAILY_USDC` optional daily spend cap
- `OPEN_PNL_PENALTY_FACTOR` penalty multiplier for negative open PnL
- `ORDER_TTL_SECONDS` desired GTD order TTL in seconds (default 60)
- `EXPIRATION_SAFETY_SECONDS` expiration safety buffer in seconds (default 60)
- `LOG_LEVEL` optional (`debug`, `info`, `warn`, `error`)

## How It Works

1) **Geoblock preflight**
   - Calls `https://polymarket.com/api/geoblock` and exits if blocked.

2) **Target resolution**
   - Accepts handles, profile URLs, or `0x...` addresses.
   - Uses Gamma `/public-search` for handle resolution.
   - Stores mappings in SQLite for fast restarts.

3) **Scoring engine**
   - Pulls `/v1/closed-positions` to compute realized PnL and ROI in the lookback window.
   - Pulls `/positions` to penalize large negative open PnL.
   - Applies minimum sample eligibility.

4) **Selection policy**
   - `LEADER`: follow only the best trader with hysteresis and cooldowns.
   - `TOPK`: follow top K with weights proportional to positive score.

5) **Trade mirroring**
   - Polls `/trades` with `takerOnly=false`.
   - Mirrors BUY and SELL.
   - SELL is clamped to current holdings from `/positions`.
   - Uses CLOB `getPrice` for executable price.
   - Applies slippage and tick size rounding.
   - Enforces `min_order_size`, per-trade caps, and daily caps.
   - Uses GTD orders with short expiry when possible; falls back to GTC if GTD is unsupported.

6) **Idempotency & persistence**
   - Composite trade key is stored in SQLite to avoid duplicate actions.
   - Trades skipped due to constraints are still marked processed.

## Safety Notes

- No profit guarantee. Adaptive selection is based on historical data and can underperform.
- Geoblocking is respected. The bot exits if blocked.
- Use `DRY_RUN=true` to validate behavior before trading.

## Files

- `src/index.ts` main loop and orchestration
- `src/config.ts` env parsing and validation
- `src/api/gamma.ts` Gamma API helpers
- `src/api/dataApi.ts` Data API helpers
- `src/api/geoblock.ts` geoblock preflight
- `src/clob.ts` CLOB client setup and helpers
- `src/state.ts` SQLite persistence layer
- `src/scoring.ts` scoring engine
- `src/selector.ts` leader/topK selection
- `src/mirror.ts` trade mirroring logic
- `src/types.ts` shared interfaces

## Disclaimer

This software is provided as-is with no warranty. Trading is risky; use at your own discretion.
