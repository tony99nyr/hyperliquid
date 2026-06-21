---
name: scout-review
description: >-
  Review the paper scout's track record and CURATE its playbook. Run weekly or
  on-demand (this is an Opus-tier task): compute the deterministic scorecard
  (net P&L after the funding+slippage haircut, run-rate vs the bar, kill/continue/
  graduate verdict), then read the resolved hypotheses and edit
  docs/scout/playbook.md — add rules the data supports, remove ones that stopped
  paying. Use when the user says "review the scout", "score the scout", "curate the
  playbook", or on the weekly cadence. NEVER trades.
---

# scout-review (the learning-loop curation — Opus)

This closes the learning loop: the scout *writes* theses and *resolves* them every
cycle; this review turns that record into a sharper playbook + a verdict against
the pre-registered bar. Run it as Opus — it's the rare, high-value pass.

## Steps

1. **Score (deterministic).** Run `pnpm scout:review`. It prints the scorecard:
   trades, win-rate, realized (net of fees), the slippage + funding haircuts, the
   honest NET, the monthly run-rate vs the $1000/mo bar, and a verdict
   (KILL / CONTINUE / GRADUATE). The scoring is deterministic — don't second-guess
   the math; interpret it.

2. **Read the record.** Pull the recent resolved hypotheses (the scorecard run
   shows counts; query `hypotheses` for the statements + resolution notes if you
   need detail). Look for PATTERNS, not single trades: which setup types won, which
   bled, where funding or chop hurt.

3. **Curate `docs/scout/playbook.md`** (this is the point):
   - ADD a dated, evidence-backed rule when ≥3–4 trades support it
     (e.g. "2026-07-01: negative-funding shorts into a flush lost 4/5 — require
     confirmed 8h+1d bearish regime before shorting against funding").
   - REMOVE / soften a rule the record no longer supports.
   - Keep it SHORT and operational — it's read every cycle. Curate, don't append
     endlessly (recency-bias is the failure mode).

4. **Report the verdict to the user.** State KILL / CONTINUE / GRADUATE + the
   run-rate vs the bar + the playbook changes you made, in a few lines.

## Guardrails

- NEVER trade or edit positions — this is analysis + a markdown edit only.
- Respect the bar: only call GRADUATE when the deterministic verdict says so
  (run-rate ≥ bar over ≥90 days with DD < 15%). Graduation means *propose* the
  Phase-2 live seam to the user — it does NOT flip anything to live.
- A KILL verdict is a real outcome — recommend stopping the lane, same as the
  rejected funding/copy-trading lanes. Don't rationalize a losing record.

## What lives where

- `scripts/scout-review.ts` — the deterministic scorecard (reads the paper ledger).
- `src/lib/scout/scout-review-business-logic.ts` — the PURE scorecard + verdict
  (the thresholds ARE the pre-registered bar).
- `docs/scout/playbook.md` — what you curate; the scout reads it every cycle.
