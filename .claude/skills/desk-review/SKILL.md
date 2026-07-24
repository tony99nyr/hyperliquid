---
name: desk-review
description: >-
  One repeatable command to investigate + analyze the WHOLE desk: open positions, armed
  ladders, draft ladders, and open previews (the book) PLUS the full market read — rubric
  opportunity board, per-coin short- vs long-term trend (multi-TF regime), reversion-extreme
  candidates, funding/OI carry, rated-leader flow, and household cross-system stacking. Use
  when the user says "desk review", "review the desk", "what's the whole picture", "go through
  the book and the market", "any opportunities", "how do we look", "investigate positions and
  ladders and market", "short and long term trends", or wants a full situational read before
  deciding anything. ADVISORY ONLY — it reads, analyzes, and recommends; it NEVER opens, closes,
  arms, or trades. Every action stays a separate, explicitly-confirmed step.
---

# desk-review (advisory, read-only)

Single purpose: give the operator ONE repeatable situational read across the whole desk —
the **book** (what we're holding / have queued) and the **market** (where the edge is, or
isn't) — synthesized through the desk discipline. **This skill never trades, arms, or
writes an order.** It is the "stand at the desk and take in the whole board" skill.

## Protocol

### 1. Gather the facts (one command)

```
pnpm skill:desk-review            # human-readable
pnpm skill:desk-review --json     # + structured JSON for deeper work
pnpm skill:desk-review --coins BTC,ETH,SOL,HYPE,DOGE   # widen the universe
```

This assembles, READ-ONLY:

- **THE BOOK** — live positions (size, entry, uPnL, ROE, leverage, liq), armed ladders,
  draft ladders, open previews (with review status).
- **THE MARKET** — per coin: mark, 24h change, **short- vs long-term trend** (LT = 1d/8h,
  ST = 1h/15m — `aligned` / `counter-trend` / `mixed`), an **opportunity flag**
  (GO / REVERSION / WATCH / NONE), the best rubric read, any reversion-extreme fade
  candidate, and funding APR.
- **SIGNALS** — rated-leader flow (12h), household on-chain stacking, circuit-breaker state.

The script prints FACTS only. Everything below is YOUR synthesis.

### 2. Read the book (risk before opportunity)

For each **open position**: hold / trim / exit? Weigh uPnL + ROE, distance to liquidation,
and the coin's trend row (is the trend still with the position?). If anything looks like it
needs action, say so plainly — but do NOT act; point the operator to `assess-trade-health`
(deep multi-TF health) or `advise-exit` (which surfaces a reduce-only order for their yes).

For each **armed ladder**: is it still coherent with the current tape (trend row, leader
flow, funding)? Flag expiry, OCO, and anything that drifted. For a real grade, defer to
`review-ladder` (the 0/10 RISK + UPSIDE scorecard) — name it, don't reproduce it.

For each **draft ladder / preview**: is it safe to arm / approve given the current read?
Again `review-ladder` / `review-previews` do the graded version; here just flag obvious
go / no-go and what's owed before arming.

### 3. Read the market (where's the edge?)

- **Stand down by default.** If every coin's opportunity flag is NONE and the rubric is all
  NO-EDGE, the honest answer is "no opportunity — stand down." Say that clearly. Do not
  manufacture a setup from a soft lean.
- **GO** = the rubric edge cleared the bar → a genuine candidate. **REVERSION** = a
  backtested fade candidate (the one forward-testing edge). **WATCH** = building, not yet
  actionable.
- **Short vs long term**: an `aligned` trend is a trend-continuation context; a
  `counter-trend` row (LT one way, ST the other) is a pullback/bounce — note which, because
  it changes whether a setup is "with" or "against" the structure.
- **Carry**: extreme funding (e.g. SOL −16% APR = crowded shorts paying) is CONTEXT, not a
  signal — funding-extreme reversion was tested and KILLED (`docs/scout/BACKTEST_FINDINGS.md`).
  Don't propose fading funding directionally.

### 3b. Proactive conditional entries — the "make opportunity" layer

The script's **CONDITIONAL-ENTRY IDEAS** section names, per coin, the resting-ladder
SHAPE that fits its structure — `reversion-fade` / `breakdown-short` / `reclaim-long` /
`bounce-short` / `dip-long`. This is the antidote to "we confirm late, so we chase or
watch it go by": instead of reacting, arm an **IF it hits X THEN enter** conditional
ladder that only fires when your pre-judged good scenario prints (a bounce to short into,
a confirmed level break, a dip to buy). We already have the engine — conditional `open`
rungs with `momentumConfirm`, stops, targets, expiry — and it's fired real entries.

For each idea worth acting on, propose the CONCRETE ladder (the operator + panel supply
conviction; you supply structure):

- **The level** — the specific trigger price off current structure (resistance for a
  bounce-short, the broken base for a breakdown, support for a dip-long). Read it from
  `analyze-market-timeframes` if you need the swing levels.
- **The confirmation** — `momentumConfirm` on the entry rung so it fires on the roll-over,
  not a naked price tag into a knife.
- **Invalidation + expiry** — stop rung baked in, and an `expiresAt` so a stale watch
  auto-cancels (structure goes stale in days).
- **Size** — graded ([[graded-entry-preference]]): a starter + scale-in, ~1% campaign risk.

Then **panel-gate it** ([[adversarial-panel-for-ladders]]) and **default to `mode: paper`**
to prove the mechanism before risking live. `reversion-fade` is the one PROVEN shape;
every other shape is discretionary scaffolding for YOUR thesis — real, but unproven, so
size and gate accordingly.

**Discipline on the armed set (this is where it goes wrong):**
- **Arm FEW.** A lattice of speculative "if it hits X" triggers is multiple-testing in an
  execution costume — most fire on noise and bleed. A handful of well-reasoned, tight ones.
- **Cap correlated exposure.** Ten short-the-bounce ladders all fire in one crypto dump =
  one concentrated bet you didn't choose. Count conditional exposure like live exposure.
- **Rotate + expire.** Keep the armed set small and current; desk-review lists it so you
  prune drift. Per-event one-offs that archive ≠ a standing practice.

### 4. Synthesize — the desk read

Deliver a tight read, not a data dump:

1. **The book in one line** — flat / what's held / what's queued, and any position that needs a decision.
2. **The market in one line** — stand-down, or the 1-2 coins with an actual flag and why.
3. **Cross-system** — if a candidate is crypto-beta-correlated, count household stacking
   ([[household]] — a long on the dominant leg stacks; a short partially hedges) and ask the
   operator for the iamrossi book's live stance when it matters.
4. **What's actionable NOW vs WATCH** — be explicit which is which.

## Discipline (the desk rules — apply every time)

- **Advisory only. Never trade, arm, or write.** Every entry/exit/arm is a separate step the
  operator confirms.
- **Stand-down is a valid, common answer.** "No edge, stand down" beats a forced setup.
  Detection surface is not the bottleneck — proven edge is.
- **Adversarial panel before ANY new entry** ([[adversarial-panel-for-ladders]]): before
  presenting a new entry as a real candidate, run the 4-skeptic panel (event / technical /
  quant / flow). desk-review surfaces a candidate; the panel earns it.
- **Graded MEDIUM entries** ([[graded-entry-preference]]): when something IS worth it, price a
  starter + scale-in beside the confirmation gate, ~1% campaign risk.
- **Escalate to the specialist skill for depth**: `analyze-market-timeframes <coin>` for a full
  per-coin read, `review-ladder` for a ladder grade, `analyze-traders` for a wallet,
  `assess-trade-health` for a live position. desk-review is the wide-angle; those are the zoom.

## When NOT to use

- A single coin's deep read → `analyze-market-timeframes`.
- Grading one ladder → `review-ladder`. A live position's health → `assess-trade-health`.
- Actually opening/closing/arming → the ACTION skills (each gated on an explicit confirm).
