# Edge Roadmap — the three-seat strategy review (2026-07-15)

Three agent seats (edge research / engine gaps / capital conversion), each grounded in
the desk's own studies and its 5 real campaigns. Full reports in the session log; this
records the CONCLUSIONS + decisions. Read with SIGNAL_ROADMAP.md and LADDER_BUILDER_GUIDE.md.

## The verdict

**At $970 this is honestly a ~$15–35/month desk.** The process is proven (every closed
dollar landed on a pre-planned rung); the EDGE is thin by construction at this capital
with 9bps taker round-trips. The fastest lever is NOT more strategies — it is:
(1) don't blow up (safety machinery), (2) prove the edge fast (sample velocity),
(3) add capital ON PROOF (the pre-registered top-up), then $100 wins are normal outcomes.
Path to $100-win tier: ~4 months, gated on proof, not hope.

## Edge taxonomy (quant seat)

| Edge | Verdict |
|---|---|
| Event-vol straddles | The ONE proven ladder edge (graduated, n=7, tail-carried). ~$5–10/mo at floor. FOMC-weighted. THE high-cadence anchor bucket. |
| Regime/trend ladders | An OPTION on the bull regime, not income (t=1.30, one regime, live ≈ $0). Run ledger-gated, floor size, kill at ≤−0.05R/n≥10. Don't tune. |
| HLP vault sleeve | Highest IC we own (+0.223) but it's an allocation-TIMING signal, and HLP is in a −17.9% month right now. 10–15% sleeve ($100–150), timing-gated (never allocate while HLP week-return < 0 — gate reads AVOID today). Not a passive park. |
| Funding carry | CANNOT be constructed on one sub-$5k account (no spot leg). The pre-registered study was NEVER RUN — run `scripts/analysis/funding-study/analyze.py` offline before any build. Do-not-build: delta-neutral carry below ~$5k. |
| Funding/OI triggers | Wait for the ~Aug 1 series re-test. Nothing wired. |
| Grid-whale shadowing | KILLED — one whale, one regime = anecdote (single-name fragility). |
| Maker/limit entries | KILLED at this size — maker/taker delta ≈ $0.06/round-trip on our notionals, and resting fills break the atomic-bracket guarantee. |

## Build order (unified across seats)

**Systems before signals** — the capital seat found three CONFIRMED safety gaps that the
multiple-concurrent-positions policy requires closed:

1. **Fire-time portfolio heat gate** (GAP 3a): `performLadderRungFire` checks only the
   single ladder's caps — nothing sums the BOOK at fire. Add an aggregate slip-aware
   heat guard (skip opens/adds over the ~8–10% ceiling; never block risk-reducing rungs).
2. **Live-scoped circuit breaker wired into the fire path** (GAP 3c): today's breaker is
   scout/paper-scoped and the ladder fire path never calls it — **a daily-loss halt does
   not freeze ladder fires**. Add scope='live' equity/peak/day tracking + a fire-path
   check (blocks opens/adds only).
3. **Beta-adjusted heat** (GAP 3b): reuse the rubric's `directionExposure` so
   same-direction majors count ~1.5×, not 3× — makes concurrency's variance discount real.
4. **True trailing ratchet** (engine seat #1): `moveTo:'trail'` — the stop follows price;
   fixes the biggest recurring leak (HYPE #1 −$3 round-trip, HYPE #2 −$1.1, ETH's
   never-armed trigger). Exit-side only.
5. **Sustained momentumConfirm** (engine seat #2): N consecutive clean candles — fixes
   the BTC top-tick fill class. Restrictive-only, small.
6. Retest/reclaim trigger (engine seat #3) — after 1–5.
7. Live-equity tracker feeds the TOP-UP criterion (below) + `vault_snapshots` populate
   feeds the HLP gate.

## Operating tempo (capital seat)

- **Concentrate to 2–3 setup buckets** (the expectancy gate is PER-SETUP: fewer buckets
  = SIZE-UP in ~5–8 weeks instead of ~13). Anchor: event-straddle (5–6 prints/mo).
- **Paper pre-qualifies new setups**: ≥+0.15R over n≥20 paper/backtest (after friction)
  before any live floor slot.
- **Pre-registered TOP-UP-to-$5k criterion** (all four, ledger-verifiable):
  (a) ≥2 buckets at HOLD-or-better (n≥10); (b) aggregate ≥+0.10R over ≥30 live closes;
  (c) realized live max-drawdown <12%; (d) ≥1 bucket earned SIZE-UP.
  Before that: adding capital amplifies noise. After it: $100 wins are the normal 2–3R
  campaign at $5k×2.5%.
