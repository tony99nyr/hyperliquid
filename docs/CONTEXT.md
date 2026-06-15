# CONTEXT — Domain language

The shared vocabulary for the HL Cockpit. Use these terms precisely; the
`improve-codebase-architecture` skill reads this file to understand the domain.

## What this is

A **human + Claude collaborative trading cockpit** for Hyperliquid. The human
sits down, runs Claude skills to analyze HL traders and multi-timeframe candles,
and together they pick a setup to follow. Claude orchestrates analysis and trade
health; **the human decides and confirms every action.** A phone-accessible web
cockpit live-renders Claude's work. **Paper-first for weeks, then flip to live
with one env var.** It lives deliberately OUTSIDE the iamrossi autonomous system.

## Core terms

- **Trading mode** — `paper` or `live`. The single switch (`TRADING_MODE`).
  Read in exactly one place (`env/mode.ts`); fail-safe to `paper`. See ADR-0001.
- **Trade intent** (`TradeIntent`) — what the human confirms: coin, side, size,
  optional limit price, reduce-only, plus a client-generated idempotency id.
  Mode-agnostic.
- **Canonical fill** (`CanonicalFill`) — the single fill record produced by BOTH
  the paper and live sources. Downstream consumes only this and cannot tell the
  modes apart. `source` is audit-only, never branched on.
- **Fill source** — `paperFill` (book-match) or `liveFill` (HL exchange). The
  ONE util `executeIntent` is the only mode branch.
- **Position** — the running fold of fills for a coin: side (long/short/flat),
  size, avg entry, realized P&L, fees. Mode-unaware.
- **Order book / l2Book** — HL level-2 book snapshot (bids/asks). The paper
  source walks a FRESH one to compute a fill (ADR-0003).

## Roles & transports (ADR-0002)

- **Market data** (price / book / trades): HL websocket → browser directly.
  Ephemeral, never stored.
- **Cockpit state** (analysis, hypotheses, fills, positions, P&L, health,
  context gauge): Claude writes Supabase rows → Postgres realtime → browser.
  Durable, the source of truth.

## Cockpit state vocabulary

- **Session** — one trading sitting; everything else FKs to it.
- **Analysis log** — Claude's live, append-only analysis stream.
- **Hypothesis** — a trade thesis being tracked (open → confirmed / invalidated
  / resolved).
- **Health snapshot** — the health engine's 0–100 score + P(continuation) /
  P(adverse) + discrete alerts, written each assessment cycle.
- **Context gauge** — a rough, **self-reported** Claude context-usage %, with a
  warning zone so the human is never caught near a limit mid-trade. A safety
  cue, NOT a precise meter.

## Risk vocabulary (why this exists)

- **Martingale / averaging down** — repeatedly adding to a loser. The leaders'
  tail this project's human-stop exists to escape.
- **Data-completeness gate** — thin/page-capped wallets can never grade clean A
  (the $16M-live-martingale lesson). ADR-0003.
- **The human is the stop** — leaders ride to liquidation; the human + Claude
  apply the discipline the leaders lack.

## Strategy engine (vendored, pure)

Regime detection, indicators (RSI/MACD/ATR/EMA/SMA), divergence / decline /
recovery detectors, ATR stop-loss, and the risk-reward validator
(`validateSignal`) are vendored verbatim from iamrossi. All pure, fixture-tested,
no I/O. The Phase 1 health engine composes them across 1d/8h/1h/15m.
