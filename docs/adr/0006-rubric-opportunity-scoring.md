# ADR-0006 — Deterministic rubric opportunity scoring

Status: Accepted (Phase 5)

## Context

The cockpit needs to surface *where the opportunity is* across the HL universe,
continuously, without a human (or Claude) eyeballing every coin. Two failure
modes to avoid:

1. **LLM-as-screener.** Asking a model to rank coins each cycle is expensive,
   non-reproducible, and impossible to backtest or to pin with a test.
2. **A single blended score** that hides *why* a setup is good or bad, and that
   lets a strong trend-following signal override a fatal structural problem
   (no room to target, a book too thin to exit, the dominant HTF against you).

We already have the vendored, pure strategy engine (regime, indicators,
ATR, validators) and a live leader feed (ADR-0002 / trader-watch). The screener
should be built from those as **deterministic, fixture-tested pure functions.**

## Decision

A deterministic **rubric** (`src/lib/rubric/**`) scores each **asset × side**
independently and resolves to an advisory badge. It never trades.

### Score shape: a multiplier × additive pillars, then hard gates

```
opportunityScore(0–100) = regimeMultiplier × (leadersPillar + carryPillar + microPillar)
                          then any failing GATE → 0
badge = GO | WATCH | NO-EDGE     (from score vs. a pre-set bar + decisiveness)
```

- **Regime is a multiplier, not a pillar.** A hostile multi-TF regime crushes an
  otherwise-good additive envelope — you don't get a GO fighting the trend just
  because leaders + carry look nice.
- **Pillars** (leaders consensus, funding/carry, micro-structure) are the
  additive edge sources, each pure and individually testable.
- **Kill-gates are boolean vetoes** (`rubric-gates-business-logic.ts`): book
  too thin (`minDepthUsd`), against a confirmed HTF, room-to-target too tight,
  vol-contraction (chop), liq-inside-stop, leader-derisk veto. ANY failing gate
  zeroes the side — **NO-TRADE is first-class**, not a low score.
- **Portfolio beta cap** (`rubric-portfolio-business-logic.ts`): scores are
  computed per-asset in isolation; a post-hoc layer downgrades over-exposed
  same-direction legs (ETH+BTC beta, HYPE) to WATCH so correlated risk can't
  stack.
- **Confidence is honest**: driven by how far above the bar + how decisive
  vs. the other side. It feeds UI dots, **not sizing**.

### Pure / I-O split (per CODE_ORGANIZATION.md)

- **Pure**: `rubric-scorers-`, `rubric-gates-`, `rubric-composer-`,
  `rubric-portfolio-`, `rubric-position-review-business-logic.ts` — all
  fixture-tested, no `Date.now()`/random.
- **I/O**: `rubric-inputs-service.ts` (assemble inputs from HL + the
  `leader_positions` feed), `rubric-scan-service.ts` (orchestrate + upsert
  `rubric_scores` / `market_snapshots` / position reviews).
- **Config**: `rubric-config.ts` — frozen, versioned tuning knobs (thresholds,
  weights, gate cutoffs) in one place.

### Cadence

`pnpm rubric` — a ~20-min full scan (`--once` / `--interval`) plus a ~5-min
open-position **review** pass (`--review`: health + HOLD/ADD/TRIM/EXIT verdict
per open leg). The cockpit Opportunity Board renders `rubric_scores` in realtime.

## Consequences

- The opportunity screen is reproducible, backtestable (the regime core is
  replayed by `src/lib/backtest/**`), and pinned by unit tests — not an opaque
  model call.
- A good edge with a fatal structural flaw correctly reads NO-EDGE rather than
  GO, because gates veto and regime multiplies.
- Tuning is one edit in `rubric-config.ts`; the pure scorers don't change.
- It is strictly **advisory** — it imports no fill/execution path. A human (or
  the paper scout, ADR-0005) still decides and the seam still gates.
