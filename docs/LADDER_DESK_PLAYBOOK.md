# The Pro-Desk Ladder Playbook (operator methodology)

How a disciplined desk turns a *thesis* into a *risk-defined, executable ladder* on this
cockpit. This is the **operator method**; the system design lives in
[`ARMED_LADDER_ARCHITECTURE.md`](./ARMED_LADDER_ARCHITECTURE.md) and the locked decisions
in [`adr/`](./adr/). Read those for *how it fires*; read this for *what to build and why*.

> One sentence: **define the most you can lose first, start small, let price earn more
> size, scale out into strength, and never average down.**

---

## 0. When a ladder is the right tool

Use a ladder when you have a directional thesis but **timing/level uncertainty** — you want
exposure to scale with confirmation rather than committing all size at one price. Do NOT use
one as a way to "set and forget" a bad idea: a ladder is a disciplined execution of a thesis
you can defend, not a substitute for the thesis.

## 1. Operating principles (the non-negotiables)

1. **Risk-first, not size-first.** Decide the campaign's *maximum loss* (a fixed % of account)
   before any price or size. Everything else is derived from it.
2. **Pyramid into strength, never average down.** Add only after the move proves the thesis and
   the existing position's profit covers the new rung's risk. The engine enforces this
   (`ladder-fire-service.ts` add-guard); treat it as your own rule, not a constraint to route
   around.
3. **The aggregate stop only ever tightens.** Never widen a stop to "give it room." Break-even
   after the first scale is a *default*, not a mandate (premature break-even causes stop-outs on
   normal breakout retests).
4. **Scale out into strength.** Bank partial profit into resistance/targets; do not hold the
   full position for a home run.
5. **Every entry is bracketed.** A stop rests atomically with each fill (native HL order), so
   protection survives even if the operator/Claude is offline.
6. **Decreasing size per rung.** Later adds are smaller, keeping the blended entry near the
   first rung.

## 2. The 6-step desk process

1. **Thesis** — write it in one sentence with an invalidation level ("long HYPE; thesis dead
   below $57 weekly support").
2. **Grade the signal** — if following a trader, grade the wallet first (`analyze-traders`;
   the INSUFFICIENT_HISTORY gate). A ladder on a bad signal is a tidy way to lose money.
3. **Regime read** — `analyze-market-timeframes`. Note alignment and any divergence; a bearish
   divergence on the entry timeframe means *smaller core, more confirmation before adds*.
4. **Risk budget** — pick the campaign max-loss % from the risk tier (§5), convert to dollars.
5. **Construct the ladder** (§3, §4) — rungs, triggers, stops, scale-outs, caps, expiry.
6. **Arm & monitor** — review in the preview/arm modal, arm with the typed approval, let the
   watcher fire. Re-check on cadence; disarm on thesis invalidation.

## 3. Ladder anatomy (mapped to the cockpit rung model)

A ladder is a list of **rungs**, each a `{deterministic trigger → pre-authorized order}`:

| Rung role | `action` | Typical `triggerKind` | Notes |
|---|---|---|---|
| **Core entry** | `open` | `price_above` (long) / `price_below` (short), or at-market | Small; the toe in the water |
| **Pyramid add** | `add` | `price_above` (long) | Fires *only if in profit* (engine add-guard); smaller than core |
| **Scale-out** | `reduce` | `price_above` (long) | Bank gains into resistance; reduce-only |
| **Structural exit** | `close` | `price_below` (long) | Backstop beyond the resting bracket stop |

Each `open`/`add` rung is **risk-sized**: you supply `riskUsd` + `stopFrac` (+ `leverage`), and
the server computes `sizeCoins = riskUsd / (mark · stopFrac)` at fire time. The protective stop
(`stopPx`) rests atomically with the fill.

## 4. Position sizing math

```
riskUsd      = accountEquity × riskPct          # campaign max-loss, per the risk tier
notionalUsd  = riskUsd / stopFrac               # how big the position can be for that risk
sizeCoins    = notionalUsd / entryPx
leverage_eff = notionalUsd / accountEquity      # keep well under the tier cap
```

**Liquidation-aware check:** the liquidation buffer ≈ `1/leverage` (5× → ~20%, 10× → ~10%).
Your **stop must trigger well before liquidation** — if `stopFrac` ≥ `1/leverage`, you can be
liquidated before your stop fills. Conservative sizing keeps `leverage_eff` low enough that this
is never close.

**Wick tax:** crypto majors/alts wick. A stop tighter than recent ATR gets knocked out on noise;
size the stop off structure/ATR, then derive notional — not the other way around.

## 5. Risk tiers (presets)

| Tier | Campaign max-loss | Effective leverage | Stop discipline |
|---|---|---|---|
| **Conservative** | ~1–2% of account | ≤ ~0.5× (spot-like) | Wide stop off weekly structure; small core |
| **Moderate** | ~2–3% | ~1–3× | Stop off daily structure |
| **Aggressive** | ~3–5% | 3×+ | Tight stop, accept more stop-outs |

> A small account (< ~$1k) on a high-vol alt should treat **Conservative as the ceiling**, not
> the floor. Leverage on a coin that does 60% drawdowns is how small accounts get liquidated on a
> wick the thesis would have survived.

## 6. Engine guardrails you are leaning on

- **No averaging-down adds** — an `add` is refused unless its worst-case loss is covered by the
  position's current unrealized profit.
- **Atomic brackets** — a fill that can't be bracketed is flattened ("filled-but-unstopped" is a
  hard fault, never tolerated).
- **Caps** — `maxTotalNotionalUsd` and `maxTotalLossUsd` bound the whole campaign.
- **Expiry** — every ladder expires; a stale thesis auto-disarms.
- **Precondition drift** — if live state diverges from the arm-time snapshot, the ladder
  auto-disarms rather than firing into a changed world.
- **Kill-switch + paper default** — `LADDER_AUTOFIRE_ENABLED` and paper mode mean nothing fires
  until you explicitly enable it.

## 7. Worked example — HYPE long, $980 account, conservative

Live mid ~$65.6; 1d bullish but with a bearish RSI divergence (→ small core, confirmation before
adds). Campaign max-loss ~2.4% (~$24); effective leverage ~0.2× (spot-like).

| # | Action | Trigger | Risk $ | Stop | ~Notional | Purpose |
|---|--------|---------|--------|------|-----------|---------|
| 1 | open (core) | ~$66.0 | $12 | ~$57.8 (-12%) | ~$100 | Toe in |
| 2 | add (pyramid) | price_above $72.0 | $8 | ~$66.5 trail | ~$100 | Adds only if rung 1 green; divergence resolved |
| 3 | reduce ~40% | price_above $74.5 | — | — | — | Bank into prior-ATH resistance |
| 4 | reduce/close | price_above $80.0 | — | — | — | Trim ATH-breakout extension |

Caps: `maxTotalNotionalUsd ≈ $220`, `maxTotalLossUsd ≈ $24`, expiry ~7 days. Worst case: ~-$20.
Best case: pyramided into a trend on house money, scaling out into strength.

## 8. Anti-patterns (do not do these)

- **Martingale / averaging down** — adding to a loser to lower the average. The single fastest
  way to blow up; engine-refused here, but never try to route around it.
- **Size-first sizing** — picking a notional/leverage and discovering the risk after.
- **Naked entries** — any fill without a resting stop.
- **Stop wider than the liquidation buffer** — you get liquidated before your stop.
- **Chasing into a divergence with full size** — the divergence is the market telling you to
  size down and demand confirmation.
- **No expiry / no invalidation** — a thesis with no "I'm wrong if…" is a hope, not a trade.

## 9. Pre-arm checklist

- [ ] Thesis written with an explicit invalidation level.
- [ ] Signal graded (if copying a trader).
- [ ] Regime + divergence read done.
- [ ] Campaign max-loss set as a % of account, in dollars.
- [ ] Every `open`/`add` rung has a stop; stop < liquidation buffer.
- [ ] Adds are confirmation-based (`price_above` for a long), decreasing in size.
- [ ] Scale-outs defined into resistance/targets.
- [ ] Caps + expiry set.
- [ ] Reviewed in the arm modal; armed with the typed approval.
</content>
</invoke>
