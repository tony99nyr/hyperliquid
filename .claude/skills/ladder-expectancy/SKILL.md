---
name: ladder-expectancy
description: >-
  Resolve terminal Hyperliquid ladders into the outcome LEDGER (planned R vs HL-realized R)
  and run the weekly EXPECTANCY review — per-setup KILL / HOLD / SIZE-UP / COLLECT verdicts
  against a pre-registered bar. Use when the user says "resolve outcomes", "expectancy
  review", "weekly ladder review", "which setups are paying", "should I size up", or after
  any ladder closes. ADVISORY ONLY — it writes ledger rows and verdicts; it never trades,
  arms, or resizes anything.
---

# ladder-expectancy (advisory)

Single purpose: the **operator-lane feedback loop** — the discipline the scout lane already
has (ADR-0005), applied to your real ladders. Without this, you cannot distinguish
profitable-by-skill from profitable-by-luck. **This skill never trades.**

## What it does

1. **RESOLVE** — every terminal ladder (`done` / `disarmed` / `expired`) becomes one
   `ladder_outcomes` row: setup type (derived from rung shape), planned risk (the engine's
   slip-aware no-netting worst case), realized PnL (**HL's own fills** — `closedPnl − fee`,
   because exchange-side stop/TP fills never pass through the app), and the R-multiple.
   Classification: `never_filled` (costless pass — selectivity, not a loss) · `open`
   (position still live; re-resolves later) · `won` / `lost` / `scratch` (|R| ≤ 0.05).
2. **REPORT** — rolls closed outcomes up **per setup type** against the **pre-registered
   bar** (`DEFAULT_EXPECTANCY_BAR`: min 10 closed trades; kill ≤ −0.05R; size-up ≥ +0.15R):
   - `COLLECT` — not enough sample; stay at floor size.
   - `KILL` — the setup doesn't pay; stop trading it.
   - `HOLD` — between bars; keep trading at current size.
   - `SIZE-UP` — earned **one** risk-tier step (e.g. 1% → 2%). Never more than one step.

## Protocol

1. Run `pnpm skill:ladder-expectancy` (resolve + report). `--report-only` skips resolution.
2. Attach thesis scores when resolving a specific ladder:
   `--ladder <id> --signal <0-10> --timing <0-10>` (the review-ladder judgment pillar,
   preserved into the ledger so expectancy can later be sliced by thesis quality).
3. Relay per-setup verdicts + reasons. A `KILL` or `SIZE-UP` is a **standing instruction**
   for future ladders — record it in the session and respect it in `review-ladder` builds.
4. Cadence: weekly, and after any ladder reaches a terminal state.

## Guardrails

- Advisory only — resolving/reporting never touches a ladder or an order.
- **The bar is pre-registered.** Never adjust `killExpectancyR` / `minTrades` after seeing
  the data to keep a favorite setup alive — that is the exact failure mode this exists to
  prevent.
- Attribution is per-coin over the ladder's window — sound under the playbook's
  one-active-campaign-per-coin rule (§5b). Overlapping same-coin trades blur it; the row is
  flagged when no fills are found.
- Requires `HL_ACCOUNT_ADDRESS` for realized math (prod); without it only `never_filled`
  outcomes fully resolve.
