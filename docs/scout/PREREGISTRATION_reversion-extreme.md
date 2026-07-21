# Pre-registration — `reversion-extreme` scout lane

**Registered 2026-07-20, BEFORE any live trade.** This is the honest record that
freezes the hypothesis and the pass/fail bar so the scout's forward paper record
is a real out-of-sample test, not a moving target.

## Hypothesis

In a **range regime**, fading a **statistically extreme** short-horizon price
stretch has positive expectancy. Momentum/breakout continuation does **not** (a
day of backtesting on 52d of 15m data killed every continuation variant; only
"fade the extreme" edged positive — best in-sample t ≈ 2.4, which does **not**
clear the multiple-testing bar, hence this forward test).

## The exact rule (frozen)

- Universe: liquid majors in the scan set (BTC/ETH/SOL/HYPE + rubric-covered).
- Signal (`reversionSignal`, `DEFAULT_REVERSION_CONFIG`): on completed 15m bars,
  - **Stretch**: |z| ≥ **2.5**, z = 16-bar log move / (σ·√16), σ = stdev of 1-bar
    returns over the 96 bars *before* the move window.
  - **Range gate**: Kaufman efficiency ratio over 96 bars ≤ **0.35** (trending
    tape is skipped — that's where fading loses).
- Trade: **FADE** (short an up-stretch / long a down-stretch). Stop beyond the
  move's extreme (+0.4% buffer); target 50% retrace of the move. Risk-sized to
  the scout floor (`--risk` small; paper-only).
- Tag every trade `lane: 'reversion'`, `setupType: 'reversion-extreme'`,
  `regime: 'range'` so both the per-lane scorecard AND `setupTypeExpectancy`
  isolate it.

## Pre-registered pass / fail bar

Judged by `scout:review` (`setupTypeExpectancy` + the per-lane scorecard):

- **KILL** if net expectancy < 0 after **15** closed trades, or net < 0 past 21
  days with ≥3 closed.
- **GRADUATE to consideration** only at **≥ 30** closed trades (the scorecard's
  `minTradesToGraduate`) AND expectancy
  **≥ +0.15R** AND positive after the standard live-decay haircut. Graduation is
  a *conversation*, never an auto-promotion — the paper/live seam stays hard.
- Regime caveat (documented, not gameable): this is a RANGE-regime edge. If the
  market is trending, the efficiency gate should yield few/no trades — a long dry
  spell in a trend is the signal working, not failing. Do not loosen the gate to
  force trades.

## Why the scout, not another backtest

Forward paper on post-discovery data is the only validation immune to the
look-ahead/overfitting bias that inflates in-sample LLM backtests (verified
literature, Jul-16 deep research). The scout already has the ledger, structured
outcomes, and multiple-testing-aware bar — this lane is exactly what that
machinery was rebuilt for.
