# Pre-registration — `htf-trend` scout lane (daily Donchian breakout)

**Registered 2026-08-01, BEFORE any lane trade.** Freezes the hypothesis + the pass/fail
bar so the forward paper record is a real out-of-sample test. This lane exists because the
2026-07-31 review found the scout's *15m-entry / 4h-regime* lanes failing on **both sides**
at once — reversion (fade, −0.55R) AND trend-follow (follow, −0.37R) — which resolves to one
conclusion: **at that timescale, majors are choppy noise** and neither persistence nor
reversion clears the ~9bps round-trip. The honest next test is a **different timescale**
(daily), with the edge most-documented to survive there: **higher-timeframe trend
persistence** (the momentum anomaly / managed-futures / turtle edge).

## Hypothesis

On a **daily** timeframe, majors exhibit **persistent trends** with positive expectancy for a
**breakout** entry held for days-to-weeks. Unlike the failed 4h regime-follow, the signal is a
clean **price breakout** (a new N-day extreme), not a regime-detector read — a deliberately
DIFFERENT mechanism, so this is a fresh test, not a rehash. Trend-following is inherently
**low win-rate, fat-right-tail**; the edge is the tails, not the hit rate.

## The exact rule (frozen)

- **Universe:** BTC, ETH, SOL, HYPE (BTC/ETH are the cleanest; alts noisier — judged per-coin
  in review, traded per the same rule).
- **Signal — evaluated ONLY on COMPLETED DAILY (1d) candles:**
  - **LONG** entry: the daily close prints **above the highest daily close of the prior 20
    days** (20-day upside breakout).
  - **SHORT** entry: the daily close prints **below the lowest daily close of the prior 20
    days** (20-day downside breakout).
- **Entry:** WITH the breakout, one position per coin, only if none open on that coin (the
  one-per-coin rule is the episode dedup — no pyramiding in v1). Risk-sized to the scout floor.
- **Stop (hard invalidation):** `stopFrac = min(2 × ATR20/entry, 0.12)` — 2× the 20-day ATR,
  capped at 12% (daily trends need room; the cap bounds the loss). Pass it as `--stop-frac`.
- **Exit (primary, MECHANICAL, non-discretionary):** a daily close through the OPPOSITE
  **10-day** channel — exit a LONG on a daily close **below the 10-day low**; exit a SHORT on a
  daily close **above the 10-day high** (the turtle trailing exit). OR the hard stop, whichever
  first. **NO fixed target** — let the trend run; the fat tails ARE the edge. No breakeven-move,
  no tighter trail (those are SEPARATE strategies to pre-register + A/B only IF this graduates).
- **Tags:** `lane: 'htf-trend'`, `setupType: 'donchian-20-10'`, `regime: 'trend'` — so the
  per-lane scorecard AND `setupTypeExpectancy` isolate it.

## Pre-registered pass / fail bar

Judged by `scout:review` (`setupTypeExpectancy` + the per-lane card):

- **KILL** if net expectancy < 0 after **12** closed trades, OR net < 0 past **120 days** with
  ≥6 closed.
- **GRADUATE to consideration** only at **≥ 20** closed trades AND expectancy **≥ +0.25R** AND
  positive after the standard live-decay haircut. Graduation is a *conversation*, never an
  auto-promotion — the paper/live seam stays hard.
- **WIN-RATE CAVEAT (do not misjudge):** trend-following is *designed* to be low win-rate
  (~35–45%) with big winners. **Judge on EXPECTANCY / R, NEVER win rate.** A 35%-win / +0.3R
  lane is a graduate; a 55%-win / −0.1R lane is a kill. A string of small losses is the *shape*,
  not a failure — the tails pay.
- **SAMPLE CAVEAT:** 20-day breakouts are RARE (a few per month across 4 coins) — the sample
  builds over **months**, not weeks. The 120-day time-based kill accounts for this; do not
  force trades or shorten the channel to speed it up (that resets the test).

## The honest limits

- **Slow to decide** (months) and **low win-rate by design** — this lane demands patience and a
  strong stomach for a losing streak that is statistically normal.
- **Compliance-on-the-model exit** (same as reversion/trend-follow): the 10-day-reversal exit is
  a deterministic SIGNAL, but the close still executes through the model's `scout:trade --exit` —
  a scout-side auto-close is the future hardening if compliance slips.
- **Implementation — BUILT 2026-08-06.** The pure signal (`htf-trend-signal-business-logic.ts`,
  fixture-tested) + the daily scan (`htf-trend-scan-service.ts`) + the `HTF-TREND SCAN` cycle
  section are live: the scout now sees the 20-day/10-day channels + ATR20 + breakout/exit levels
  each cycle. The forward test begins once the scout daemon is revived and trades this lane per
  this frozen rule; NO trade counts before then. (Exit is `htfTrendExitHit` — the 10-day-channel
  close-through — surfaced for the model; nothing auto-fires it, per the honest limit above.)

## Why this, and why it's a fair test

- **Different timescale + different mechanism** from everything that failed: daily (not 4h),
  price breakout (not regime-detector), days-to-weeks hold (not hours). It is not a tweaked
  re-test of a killed setup — it's a new pre-registration.
- **The most-documented real trend edge:** Donchian-channel breakout is the turtle system;
  time-series momentum at monthly+ horizons is one of the most robust anomalies in the
  literature. If a mechanical edge exists for this account anywhere, HTF trend is the prior.
- **Capacity-friendly for a small account:** fewer, longer trades = fewer fee round-trips (the
  ~9bps that killed the 15m lanes), and the setup doesn't need size to work.
