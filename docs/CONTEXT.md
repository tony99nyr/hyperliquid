# CONTEXT — Domain language

The shared vocabulary for the HL Cockpit. Use these terms precisely; the
`improve-codebase-architecture` skill reads this file to understand the domain.

## What this is

A **human + Claude collaborative trading cockpit** for Hyperliquid. The human
sits down, runs Claude skills to analyze HL traders and multi-timeframe candles,
and together they pick a setup to follow. Claude orchestrates analysis and trade
health; **the human decides and confirms every action.** A phone-accessible web
cockpit live-renders Claude's work. **STATUS: LIVE — `TRADING_MODE=live`, real orders
fire** (incl. autonomous armed-ladder fires; the scout remains separately paper-only; see
the root `CLAUDE.md` STATUS banner). It lives deliberately OUTSIDE the iamrossi autonomous system.

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
- **Preview** — an operator-queued *proposed* OPEN sitting in the cockpit
  (`pending_actions`, kind `preview`). Claude can write an advisory review onto
  it (`review-previews`); only the operator's UI **Approve** ever fires it.
- **Safe-Exit plan** — the always-available panic close. `buildBestExitPlan`
  (PURE) picks MARKET reduce-only when health is adverse/urgent or the book is
  thin, else a LIMIT reduce-only at the favorable top-of-book. Refreshed each
  cycle so the panic button is backed by a fresh, smart plan.

## Opportunity & leader vocabulary

- **Rubric** — the deterministic opportunity scorer. Per **asset × side** it
  computes an opportunity score (0–100) as `regime-multiplier × (leaders + carry
  + micro)` pillars, then applies boolean **kill-gates** (book-too-thin,
  against-confirmed-HTF, room-too-tight, vol-contraction, leader-derisk veto) —
  any gate zeroes the side. Resolves to a **badge**: GO / WATCH / NO-EDGE. A
  **portfolio beta cap** downgrades over-exposed same-direction legs to WATCH.
  Advisory only; feeds the cockpit **Opportunity Board**. See ADR-0006.
- **Opportunity Board** — the cockpit panel rendering the latest `rubric_scores`
  (one card per scanned coin: badge + entry/stop/target zones).
- **Leader / leader feed** — `trader-watch` polls top-N rated leaders, diffs
  their positions, and writes one central `leader_positions` (reconciled each
  cycle) + `leader_actions` (open/add/reduce/close/flip) feed the cockpit + the
  rubric's leader pillar consume — instead of every client hammering HL.

## Autonomous PAPER scout (ADR-0005)

- **Scout** — an autonomous, **paper-only** opportunity finder + manager. It is
  the ONE path that executes without the human approval popup — allowed for
  paper fills ONLY, hard-guarded by `assertScoutPaperMode` (the boundary travels
  with the intent: `origin: 'scout'` is refused live at the seam). Runs on the
  cheap-model tier; escalates to Opus only for ambiguous calls.
- **Playbook** (`docs/scout/playbook.md`) — the scout's curated trading rules;
  read each cycle, deliberately updated by the weekly `scout-review` (not
  recency-biased).
- **Track record** — the scout's resolved `hypotheses` + `fills`/`pnl`, scored
  on a **pre-registered kill/graduation bar** (paper net P&L incl. modeled
  funding + slippage) decided before looking at results.

## Risk layers (no-auto-fire preserved)

- **Auto-exit (Layer 1)** — a scoped, structurally **exit-only** autonomous
  close on hard risk triggers (liq-proximity / loss / unhealthy). Can only
  reduce/close (never open/add/flip). BUILT, shipped DISABLED. See
  `docs/LIVE_AUTO_EXIT.md` + ADR-0007.
- **Circuit-breaker** — account-level daily-loss / drawdown halt: BLOCKS new
  entries and *recommends* a flatten (never auto-fires it). The account brake
  per-trade stops can't provide. See ADR-0007.

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
