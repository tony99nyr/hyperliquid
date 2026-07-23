# Funding-extreme reversion — KILLED (pre-registered, 2026-07-23)

**Question:** does fading a funding-rate extreme (crowded positioning) capture a
directional mean-reversion — and does the carry you collect by fading compound it?

**Answer: NO.** Pre-registered bar (pooled mean > 0, t ≥ 2.0, ≥2/3 assets positive,
n ≥ 30, at the primary 2-day hold) **FAILED at both thresholds. KILL.**

## The numbers (BTC/ETH/SOL, 2024-06 → 2026-07, daily grid, 7d trailing funding z)

| cell | pooled n | mean net | t | win | note |
|---|---|---|---|---|---|
| Z=1.5 H=2 (primary) | 439 | +0.048% | **+0.22** | 54% | fail |
| Z=2.0 H=2 (primary) | 282 | +0.203% | **+0.68** | 56% | fail |

- Well-powered null (282–590 trades) — a real t≥2 edge would surface at these n. It doesn't.
- The positive pooled mean is **BTC-only**; ETH and SOL are noise/negative → not
  sign-consistent (the "one asset looks good by chance" trap).
- **Carry tailwind from fading is negligible**: funding component +0.02–0.04%/trade.
  The "reversion + carry compound" thesis is true in sign but immaterial in size.
- **Not regime-conditional in any stable way**: strongly + in some bear eras
  (2026 Feb–Mar +2.5%), strongly − in others (2026 May–Jul −1.67%). Noise, not structure.
- No strong momentum either (fade net isn't significantly negative), so "follow funding"
  is not a hidden edge here.

## Decision

**Do not build a funding-extreme lane.** Funding stays what it already is in the
cockpit: a rubric **carry pillar** (delta-neutral harvest economics) + **context**,
not a directional signal. This confirms the standing read — the one candidate edge
remains price **reversion-extreme** (already forward-testing); don't spend
multiple-testing budget mining funding directionally.

Reproduce: `python3 scripts/analysis/funding-reversion-study/{fetch_data,analyze}.py`
(data cached under `data/backups/funding-reversion-study/`).
