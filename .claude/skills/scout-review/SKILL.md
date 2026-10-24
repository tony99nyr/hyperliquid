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


## Evidence-based judgment rules (Jul-16 review — verified literature)

Beyond the deterministic scorecard (which now enforces the decay-adjusted bar and
the fee-drag ceiling in code), the Opus review MUST apply these judgment checks:

- **Multiplicity**: every re-test of a tweaked setup counts as a TRIAL. Track the
  trial count per setup family; a marginal edge after many looks is noise (after
  ~20 looks a false positive is EXPECTED, not unlikely). Demand stronger evidence
  the more variants were tried — the t≈3 spirit, not t≈2.
- **Regime coverage**: paper validation in ONE regime does not transfer (LLM agents
  measurably fail regime-dependently). No graduation opinion without coverage of at
  least one full bull-bear cycle, or an explicit regime gate in the setup itself.
- **Survivorship**: the playbook may only gain a rule from the RESOLVED-hypothesis
  record (cite the hypothesis ids), never from a single memorable anecdote. The
  scout_decisions trial ledger (incl. stand-downs) is part of the record.
- **Janitorial rows**: hypotheses with `excluded=true` are NOT trades — never count
  them in win-rate or expectancy.

## Steps

1. **Score (deterministic).** Run `pnpm scout:review -- --write` to record the
   verdict in `scout_reviews`. Without `--write`, the command only reads and
   prints the scorecard. It prints:
   trades, win-rate, realized (net of fees), the slippage + funding haircuts, the
   honest NET, and verdicts (KILL / CONTINUE / GRADUATE). Per-lane verdicts use the
   per-lane bars (`data/scout/lane-bars-*.json`, rationale in
   `docs/scout/PREREGISTRATION_*.md`); the account aggregate uses the bar in
   `scout-review-business-logic.ts`. The scoring is deterministic: don't
   second-guess the math; interpret it.

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
- Respect the bar: only call GRADUATE when the deterministic verdict says so (the
  thresholds live in the files above; do not restate them). Graduation means *propose* the
  Phase-2 live seam to the user — it does NOT flip anything to live.
- A KILL verdict is a real outcome — recommend stopping the lane, same as the
  rejected funding/copy-trading lanes. Don't rationalize a losing record.

## What lives where

- `scripts/scout-review.ts` — the deterministic scorecard (reads the paper ledger).
- `src/lib/scout/scout-review-business-logic.ts`: the PURE account scorecard + verdict.
- `data/scout/lane-bars-*.json`: the per-lane pre-registered bars.
- `docs/scout/playbook.md` — what you curate; the scout reads it every cycle.
