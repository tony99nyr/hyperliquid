---
name: review-ladder
description: >-
  Run the "pro-desk" critical reviewers over Hyperliquid ladder positions — score RISK and
  UPSIDE pillars 0/10 and surface hard blockers. Use when the user says "review the ladders",
  "review this ladder", "score my ladder", "is this draft safe to arm", "critique the open
  ladders", "help me build a ladder", or wants a desk-grade read before arming. Works on OPEN
  (armed) ladders, DRAFT ladders, and as a rubric while BUILDING one. ADVISORY ONLY — it
  scores and recommends; it NEVER arms or trades (the operator arms in the cockpit).
---

# review-ladder (advisory)

Single purpose: apply the adversarial **pro-desk review panel** to a ladder as a deterministic
**0/10 scorecard** across two axes — RISK (is it safe / well-managed?) and UPSIDE (is the
payoff worth it?). **This skill never arms or trades.** It complements
[`LADDER_DESK_PLAYBOOK.md`](../../../docs/LADDER_DESK_PLAYBOOK.md): the playbook is *how to
build*; this is *how the desk grades what you built*.

## The reviewers (lenses)

Each pillar is owned by one industry lens — the same panel that hardened the playbook:

| Lens | Cares about |
|---|---|
| **Risk (CRO)** | sizing as % of equity, loss-cap honesty, portfolio/book heat |
| **Derivatives execution** | liquidation buffer vs the *slipped* stop fill, funding/carry |
| **Quant volatility** | reward:risk (R-multiple), convexity, vol-aware stops |
| **Process & psychology** | pyramiding discipline (decreasing size, no martingale), scale-out plan |
| **Crypto tail-risk** | stop integrity, gap/wick survival, unbounded-loss traps |
| **Judgment** (you) | thesis/signal quality + entry timing — from analyze-market / analyze-traders |

## Pillars (0/10 — higher is always better)

**RISK** — Liquidation safety · Loss cap & sizing · Stop integrity · Pyramiding discipline ·
Funding/carry · Operational guards.
**UPSIDE** — Reward:risk · Scale-out plan · Convexity (pyramid) · Thesis & timing.

The five engine-derived pillars are scored deterministically from the consent math
(`computeLadderRisk` + `validateLadderForArm` — slip-aware, no-netting). **Thesis & timing is
NOT auto-scored** — you supply it after a market/trader read (see protocol).

## Protocol

1. **Review open / draft ladders:** run
   `pnpm skill:review-ladder [--ladder <id>] [--equity <usd>] [--session <id>]`.
   - No `--ladder` → scores every ARMED + DRAFT ladder + the aggregate book heat.
   - Always pass `--equity` (account size) so the loss-cap pillar reads as % of account.
2. **Add the judgment pillar:** if the user wants the thesis scored, first run
   `analyze-market-timeframes` (regime/divergence) and, for a copy trade, `analyze-traders`
   (leader grade). Translate to 0-10 and re-run with `--signal <0-10> --timing <0-10>`.
3. **Relay** the verdict, RISK/10 + UPSIDE/10, every pillar score + note, and **call out
   every blocker loudly** (a blocker means it won't/ shouldn't arm until cleared).
4. **Build mode:** when helping construct a ladder, use the pillars as the design rubric —
   draft rungs (per the playbook), create the DRAFT (`/api/cockpit/ladder`), then run this
   skill on it and iterate until RISK ≥ ~7 with no blockers before handing it to the operator
   to arm.
5. Never arm. If the scorecard is clean and the user wants to proceed, they arm in the
   cockpit (typed phrase) — that is the authorization gate.

## How to read a blocker

Blockers are hard, arm-stopping issues (the cockpit's Arm button gates on them too):
unstopped/mis-sided rung, worst case exceeding the loss cap, a martingale (non-decreasing)
add, an expired ladder. A blocker caps its pillar low and must be fixed in the draft — not
worked around.

## Guardrails

- Advisory only — no `executeIntent`, no arm, no disarm. Reviewing never moves money.
- The score is decision support, not a green light: a 10/10 RISK ladder on a bad thesis is
  still a bad trade — that's what the Thesis & timing pillar is for.
- Worst-case numbers are the engine's slip-aware no-netting figures; don't soften them.
