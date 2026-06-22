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

## UPDATE (2026-06-22) — maker execution FLIPS the sign

The friction hypothesis was tested directly with a maker fill model (passive limit
entries: earn the rebate, fill only when price trades to you, MISS runaway winners;
protective stops still cross as taker). Same signals, 90d, 4 coins:

| Variant | net | win% |
|---|---:|---:|
| baseline (taker) | −$214 | 35% |
| **MAKER (trend)** | **+$266** | 35% |
| **MAKER + quick-target** | **+$242** | 44% |

**The same trend signal flips from −$214 (taker) to +$266 (maker)** — positive on
ETH/BTC/HYPE. **Friction was the killer, not the signal.** Earning the spread
instead of paying it crosses the trend core from disproven to plausible.

CAVEAT FLAGGED: the maker model was OPTIMISTIC (no queue position, no
"filled-then-reversed" adverse selection). So we hardened it and re-ran ↓

## UPDATE 2 (2026-06-22) — the maker win was a FILL MIRAGE

Added realistic maker frictions: a fill requires price to trade THROUGH the limit
by a queue-clearance margin (a touch alone leaves you behind the queue), plus an
adverse-selection penalty on entry (you fill because flow ran into you). 90d/4coins:

| Variant | net |
|---|---:|
| baseline (taker) | −$189 |
| MAKER-optimistic (touch fills, no adverse-sel) | +$274 |
| **MAKER-REALISTIC** (5bps queue + 10bps adverse-sel) | **−$190** |
| MAKER-REAL + quick-target | −$367 |

**The +$274 evaporates to −$190 once fills are realistic — identical to taker.**
The optimistic edge was entirely an artifact of assuming you fill at your limit
with no queue and no adverse selection. For a passive bid that fills when price
comes back to you in a trending market, adverse selection is structural (you fill
the reversals, miss the runners). Sensitivity: the result swings ~$460 across the
realism levers, so maker viability hinges entirely on real-world adverse selection
— which is unfavorable for a directional passive entry.

**FINAL VERDICT: the directional/trend core has NO edge — taker OR realistic maker.**
Maker execution does not rescue it. Stop trying to trade this signal directionally.
The defensible path to the (lumpy, ~$400/mo-over-a-year, compounding) goal is
STRUCTURAL, not directional: idle-capital yield + delta-neutral funding carry +
capital preservation (account-level circuit breaker), with the rubric used only as
a sit-out / risk-overlay. Same fail-fast discipline as the rejected lanes.

## UPDATE 3 (2026-06-22) — OOS multi-regime: the edge is REGIME-CONDITIONAL (verdict overturned)

The earlier "no edge" came from testing **1h candles in a recent CHOP regime**. An
out-of-sample walk-forward (`pnpm backtest:oos`) on **4h candles across 8×90d
windows / ~2 years, full data coverage (24/24 coin-windows)** tells a different story:

- **18 strongly-trending coin-windows (|move|≥15%) → 13 net-POSITIVE (72%).**
- Strong UP (2024 bull, mid-2025): ETH +$352, SOL +$493, BTC +$214, ETH +$257.
- Strong DOWN: also positive (it shorts the bear): ETH +$203, SOL +$409/+$144/+$94.
- CHOP windows: negative/breakeven — the known chop-bleed.
- Net across 8 windows ≈ **+$1,900 on $1k notional (~+$79/mo avg)** — TAKER,
  single-TF, leaders-ablated, no funding.

**Two artifacts had hidden the edge:** (1) testing the chop regime (trend-following's
worst), and (2) the 1h timeframe (~90 trades/window → friction bled it out). On 4h
(~25 cleaner trades/window) across real trends, the trend core behaves exactly as
trend-following should: **wins in trends (up AND down), loses in chop.**

CAVEATS: lumpy (concentrated in trend windows); BTC is the weak coin (often negative
even in trends — ETH/SOL carry it); ~$79/mo on $1k scales with capital; still
single-TF / ablated / no funding. But the headline stands: **there IS a
regime-conditional edge — "no edge" was regime+timeframe-specific, not universal.**

### Chop-gate test (2026-06-22): the gate does NOT help — but coin-selection does

Hypothesis "trade trends + SIT OUT chop (vol-contraction gate)" was TESTED across
the 8 windows: **raw trend +$1,903 vs chop-gated +$1,778 (slightly worse).** The
regime-confirmation requirement ALREADY filters chop (neutral regime → no trade),
so the explicit vol-contraction gate is redundant and sometimes cuts pre-breakout
entries. Sitting-out-chop is NOT the lever.

THE REAL LEVERS (from per-coin sums over ~2yr on $1k):
- **ETH ≈ +$843, SOL ≈ +$1,056** — they carry the entire edge.
- **BTC ≈ $0** — breakeven, choppy, adds variance with no edge.
→ Next levers: (1) COIN SELECTION (focus ETH/SOL, drop/down-weight BTC); (2)
CONFIDENCE-SCALED SIZING — but first verify confidence is CALIBRATED (do
higher-confidence trades actually perform better? — bucket-test in the harness)
before sizing by it. The edge itself is the regime-confirmed trend core; refine it
via WHAT (coins) and HOW MUCH (calibrated sizing), not an extra chop gate.

### Confidence calibration (2026-06-22): confidence is a GATE, NOT a sizing dial

Before building confidence-scaled sizing we tested whether confidence is calibrated
(`pnpm backtest:calibration` — pools every closed trade across 8×90d/4h windows,
BTC/ETH/SOL, buckets by ENTRY confidence). 624 trades:

| confidence | trades | win% | avg/trade |
|---|---:|---:|---:|
| 0.50–0.60 | 253 | 39% | +$2.31 |
| 0.60–0.70 | 109 | 37% | +$4.11 |
| 0.70–0.80 | 48 | 42% | +$3.84 |
| 0.80–1.00 | 214 | 41% | +$3.27 |

**FLAT / NON-CALIBRATED.** All four bands are profitable in a tight $2.31–$4.11
range; win rates cluster 37–42%; there is NO monotonic gradient (peaks at 0.60–0.70,
drifts down). Top−bottom expectancy = +$0.96 vs a pooled per-trade |avg| of $3.07 —
the spread is well under one trade's expectancy, i.e. noise. The highest-confidence
band (0.80–1.00) does NOT outperform; it's mid-pack.

→ **Confidence-scaled sizing is REJECTED — it would overfit noise.** Confidence
earns its keep as the GO/NO-TRADE gate (the threshold that produces these profitable
trades at all), but it carries no information about trade *magnitude*. The scout's
per-trade risk/leverage should NOT be scaled by confidence; keep sizing fixed
(risk-based, leverage-independent — as `open-position-business-logic.ts` already does).
The remaining lever is WHAT (coin selection: ETH/SOL carry, BTC≈$0), evaluated
against overfitting risk on a 2yr sample.

### Exit policy (2026-06-22): trailing stop does NOT beat the fixed target

A fixed ATR target caps trend winners (anti-trend-following), so we built a
trailing-stop exit (ratcheting ATR stop, no fixed target — let winners run) and
compared it head-to-head (`pnpm backtest:exit`, same 8×90d/4h windows):

| trail width | fixed total | trail total | biggest single win (fixed→trail) |
|---|---:|---:|---|
| 1.5×ATR | +$1,915 | **+$718** | $187 → $261 |
| 3.0×ATR | +$1,915 | **+$1,774** | $187 → $380 |

A tight (1.5×) trail whipsaws on intra-trend pullbacks and loses badly. A wide
(3×) trail is a **WASH** — it rides the fat tail (max win nearly doubles) but
gives it back on the choppy coins. **Exit policy is not a material lever; the edge
lives in the entry/regime, not the exit.** Keep the simpler fixed target. (Two
widths bracket the result — not mining the exact value, that's overfitting.)

Coin-conditional note (NOT acted on — overfit risk): ETH *improves* under trailing
at both widths (+$853 → +$1,141/+$1,192); BTC/SOL get worse. Cleanly-trending
instruments reward letting winners run; choppy ones punish it. Consistent with the
ETH/SOL-carry, BTC-chop pattern, but too sample-specific to build a rule on.

### Parked: leaders/carry/micro pillar replay is DATA-BLOCKED

The only untested edge source (the multi-pillar rubric) needs historical
funding/OI/leader-flow that the system only started logging into `market_snapshots`
TODAY — as of 2026-06-22 there are ~2.5h banked (120 rows, 30/coin; `leader_net`
IS populating). Revisit once weeks of history accumulate. Until then the trend core
is the only backtestable signal, and it's been exhausted on the levers above.

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
