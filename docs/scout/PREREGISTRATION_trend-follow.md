# Pre-registration — `trend-follow` scout lane

**Registered 2026-07-28, BEFORE any lane trade.** Freezes the hypothesis + the
pass/fail bar so the scout's forward paper record is a real out-of-sample test.
This is the paper twin of the edge we operate manually via the **trend-alert**
(8h-stance → live pyramiding ladder) — handed to the scout to VERIFY, the same
way `reversion-extreme` was.

## Hypothesis

In a **confident directional 4h trend**, entering **WITH** the trend (long a
bullish regime / short a bearish one) has positive expectancy. This is the exact
complement of `reversion-extreme` (which fades **range** dislocations): the two
share one threshold and are mutually exclusive by construction — above the
confidence line the reversion lane skips and this lane is live; below it, vice
versa.

## The exact rule (frozen)

- Universe: the scan-set majors (BTC/ETH/SOL/HYPE + rubric-covered).
- **Signal**: the cycle's 4h regime read (vendored `detectMarketRegime` on HL 4h
  candles — coupling-free) shows `regime ∈ {bullish, bearish}` with
  `confidence ≥ 0.55` (= `DEFAULT_REVERSION_CONFIG.maxTrendConfidence`, the SAME
  line that gates reversion OFF).
- **Entry**: WITH the trend — bullish → **long**, bearish → **short**. One position
  per coin; enter only when there is **no open trend-follow position on that coin**
  (the one-per-coin rule IS the episode dedup — no pyramiding in paper v1).
- **Stop**: frozen **4%** (`--stop-frac 0.04`) — trends need room; the invalidation
  is "the trend broke hard against me". Risk-sized to the scout floor (`--risk`).
- **Exit** (MECHANICAL, non-discretionary): CLOSE the full position when the 4h
  regime is **no longer a confident trend in the entry direction** (regime → neutral
  OR flips to the opposite) — ride until the trend ends — OR the 4% stop, whichever
  first. **No fixed target** (a target undersells a trend; trends run). **No trail /
  no breakeven-move** — those are SEPARATE strategies to pre-register + A/B only IF
  this lane graduates.
- **Tags**: `lane: 'trend-follow'`, `setupType: 'trend-follow'`, `regime` = the trend
  label — so the per-lane scorecard AND `setupTypeExpectancy` isolate it.

## Pre-registered pass / fail bar

Judged by `scout:review` (`setupTypeExpectancy` + the per-lane scorecard):

- **KILL** if net expectancy < 0 after **15** closed trades, OR net < 0 past 21 days
  with ≥3 closed.
- **GRADUATE to consideration** only at **≥ 30** closed trades AND expectancy
  **≥ +0.15R** AND positive after the standard live-decay haircut. Graduation is a
  *conversation*, never an auto-promotion — the paper/live seam stays hard.
- Regime caveat (documented, not gameable): this is a TREND-regime edge. A
  range-bound tape yields few/no trades — a dry spell in a range is the signal
  working (the reversion lane's mirror image), not failing. Do not loosen the
  confidence gate to force trades.

## The honest limit (same as reversion's target-close)

Nothing auto-fires the exit. The exit is a deterministic CONDITION (regime left the
confident trend, surfaced in the cycle's REGIME section every scan) plus this hard
rule — but the close still executes through the model's `scout:trade --exit` call,
so compliance is on the model. A scout-side auto-close mirroring `risk-exit` is the
future hardening if compliance slips.

## Why the scout, not the live trend-alert record

The live trend-alert drafts operator-armed ladders — that record measures our
EXECUTION (entry timing + discretion + the panel). This lane measures whether the
*signal itself* has edge, autonomously and cleanly, on post-registration data. It is
the coupling-free proxy for the iamrossi 8h trend edge: the Phase-1 regime-vision
work verified the scout's 4h read reproduces the trend system's read, with ZERO
cross-system dependency in the scout's loop.
