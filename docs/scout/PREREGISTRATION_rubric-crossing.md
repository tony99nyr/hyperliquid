# Pre-registration — `rubric-crossing` scout lane (breakdown-short / reclaim-long)

**Registered 2026-07-28, BEFORE any lane trade.** Freezes the hypothesis + the
pass/fail bar. This turns the desk-review conditional shapes **breakdown-short**
and **reclaim-long** — which we've operated by hand as armed ladders — into a
mechanical, autonomously-tested scout lane, and **RETIRES the `directional`
catch-all** (0/6, un-pre-registered, unfalsifiable) it replaces.

## Hypothesis

A **rubric opportunity score crossing UP into GO** (the deterministic multi-pillar
edge clearing its bar) has positive follow-through expectancy in the crossing
side's direction:
- a **SHORT** side crossing into GO = `breakdown-short` (the level gives way);
- a **LONG** side crossing into GO = `reclaim-long` (the level reclaims).

## The exact rule (frozen)

- Universe: the scan-set majors (BTC/ETH/SOL/HYPE + rubric-covered).
- **Signal**: the cycle's rubric read shows a side's badge = **GO** (the existing
  `rubric-go` WATCH/NO-EDGE → GO crossing that already wakes the scout).
- **Entry**: in the rubric side's direction. SHORT-GO → **short** (`lane
  'breakdown-short'`); LONG-GO → **long** (`lane 'reclaim-long'`). One position per
  coin×side; enter only when there is **no open rubric-crossing position on that
  coin×side** (that IS the crossing dedup in paper v1 — you won't re-enter while
  holding; after an exit, a fresh GO re-enters).
- **Stop**: frozen **2.5%** (`--stop-frac 0.025`). Risk-sized to the scout floor.
- **Exit** (MECHANICAL, non-discretionary): CLOSE the full position when the rubric
  side **drops out of GO** (badge → WATCH / NO-EDGE — the edge is gone) — the rubric
  edge persisting IS the hold thesis — OR the 2.5% stop, whichever first. No separate
  target; no trail (A/B only IF this lane graduates).
- **Tags**: `lane: 'breakdown-short' | 'reclaim-long'`, `setupType:
  'rubric-crossing'`, record the rubric `opportunity` at entry — so the per-lane
  scorecard splits the two sides AND `setupTypeExpectancy` scores the crossing as
  one family (a side may work while the other doesn't — like the per-wallet
  leader-follow split).

## Retiring `directional`

The `directional` lane was a discretionary catch-all: rubric/price-driven bets with
no frozen rule, so its record (0 wins / 6) could never graduate or falsify anything.
It is **retired** — the scout takes **no untagged directional entry**. Every
rubric-driven entry is one of the two tagged crossings above; anything else is a
stand-down. Historical `directional` + null-lane rows stay in the ledger as the
closed record; no NEW trade is tagged `directional`.

## Pre-registered pass / fail bar

Judged by `scout:review` (`setupTypeExpectancy` for the `rubric-crossing` family +
the per-lane `breakdown-short` / `reclaim-long` cards):

- **KILL** (the family, or a single side) if net expectancy < 0 after **15** closed
  trades, OR net < 0 past 21 days with ≥3 closed.
- **GRADUATE** only at **≥ 30** closed trades AND expectancy **≥ +0.15R** AND positive
  after the live-decay haircut. A conversation, never an auto-promotion.
- Multiplicity note: breakdown-short and reclaim-long are TWO looks at one signal —
  demand the stronger bar (t≈3 spirit) before reading a one-sided edge as real.
- **Bar-counting clarification (2026-08-13, PRE-DATA, n≈0):** the KILL/GRADUATE trade
  counts are judged on the **COMBINED family n** (`setupType='rubric-crossing'`, which
  aggregates both lanes), not per-lane card n — otherwise the split tags let the family
  churn ~2× the registered bar before either card trips (the exact between-review
  enforcement gap of the 08-13 trend-follow incident). The per-side KILL option above
  still exists, but the family bar fires on family n.

## The honest limit

Same as the trend-follow + reversion lanes: the exit is a deterministic CONDITION
(the rubric side left GO, surfaced every cycle) plus this hard rule, but the close
executes through the model's `scout:trade --exit` — compliance is on the model until
a scout-side auto-close is built.
