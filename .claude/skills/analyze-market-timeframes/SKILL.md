---
name: analyze-market-timeframes
description: >-
  Multi-timeframe (1d / 8h / 1h / 15m) regime, indicator, and divergence read for
  a coin on Hyperliquid. Use when the user says "analyze the market", "check the
  timeframes", "what's the regime on ETH", "read the chart", "is this a good
  setup", or names a coin to assess before entering. ADVISORY ONLY — it reads and
  reports; it never opens a position.
---

# analyze-market-timeframes (advisory)

Single purpose: compose a structured multi-timeframe read for one coin and write
it to the analysis stream. **This skill never trades.**

## What it reads

For each of 1d / 8h / 1h / 15m (via the candle-service + vendored pure strategy
functions): market regime + confidence, RSI, ATR, and the strongest RSI/MACD
divergence. It then computes a weighted directional bias (higher TFs weight
trend) and whether the higher and lower timeframes agree (alignment).

## Protocol

1. Confirm the active session id and the coin (e.g. ETH, BTC).
2. Run: `pnpm skill:analyze-market --session <id> --coin <COIN>`.
3. The script fetches ~400 candles per timeframe (read-only), composes the
   assessment via the PURE composer, and writes an `analysis_log` row.
4. Relay to the user: the per-TF reads, the net bias label, and whether the
   timeframes are aligned. Call out any opposing divergence.
5. If the user wants to act on the setup, hand off to `open-position` — and
   remind them they will confirm explicitly before anything executes.

## Guardrails

- Advisory only — no `executeIntent`, no orders.
- A thin-candle timeframe is reported as "insufficient" rather than guessed.
- Do not turn an analysis into an order; that is `open-position`'s job, and only
  after explicit user confirmation.
