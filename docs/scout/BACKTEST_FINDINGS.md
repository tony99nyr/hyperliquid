# Backtest findings — regime/trend core (2026-06-22)

First results from the backtest harness (`pnpm backtest`, `pnpm backtest:study`).
**Scope/limits:** single-timeframe candle replay; leaders/carry/micro **excluded**
(the leaders-ablation); fills modeled by per-coin adverse slippage (no historical
L2); no historical funding (carry excluded). So this is a directional edge check
of the **regime/trend core**, NOT a verdict on the full multi-pillar rubric.

## Result — the trend core has no edge (after friction)

90-day window, ETH/BTC/SOL/HYPE, per-trade notional $1000:

| Variant | net | win% | stops/targets |
|---|---:|---:|---|
| baseline (trend, conf 0.5, stop 1.5× / target 3.0×) | **−$154** | 35% | 232/124 |
| earlier entry (conf 0.35) | −$407 | 34% | 301/164 |
| wider stop (2.5×) | −$238 | 44% | 141/116 |
| quick target (2.0×) | −$344 | 44% | 263/209 |
| **FADE the regime (mean-reversion)** | **−$514** | 36% | 243/129 |
| FADE + quick target | **−$1187** | 42% | 282/202 |

(An earlier ETH-only 60d run showed +$113 — a lucky window. The broader 4-coin /
90d picture is the honest one.)

## Conclusions

1. **No edge, either direction.** Trend AND its exact inverse (fade) both lose
   heavily → the regime signal carries no directional information at this
   timeframe; **friction dominates** (~25–50bps round-trip × hundreds of trades).
2. **The "late entry" hypothesis is rejected** — entering *earlier* (lower
   confidence) made it materially worse (−$407), i.e. it's not late, it's not
   predictive.
3. **Tuning doesn't rescue it** — none of wider-stop / quick-target / earlier
   cleared anything close to the $1000/mo bar. This was a small MECHANISM study,
   not a parameter sweep, precisely to avoid overfitting a fix that isn't there.
4. **Only HYPE trends cleanly** (positive on trend, deeply negative on fade);
   ETH/BTC/SOL chop and pay the spread.

## Implications

- **Do NOT go live on the current rubric.** The backtestable part (regime core)
  loses; the potentially-edge-bearing pillars (leaders/carry/micro) are unproven
  and not yet backtestable (data-blocked — `market_snapshots` is accumulating the
  funding/OI/leader history a fuller replay would need).
- The system's defensible value remains **drawdown-reduction / discipline (sitting
  out)**, not alpha — consistent with the original benchmark conclusions.
- Same fail-fast discipline that rejected the funding/copy-trading lanes: the
  trend core is **REJECTED as a standalone entry signal**.

## Open / next (operator's call)

- **Gather + revisit:** once `market_snapshots` has weeks of history, extend the
  harness to replay the full multi-pillar rubric (the only untested edge source).
- **One different signal:** a Bollinger-band mean-reversion *in low-vol regimes*
  (distinct from regime-direction) — low expectations given friction dominates.
- Friction is the killer: any viable lane needs far fewer/higher-conviction
  trades, a genuinely predictive signal, or maker/passive execution (not taker).
