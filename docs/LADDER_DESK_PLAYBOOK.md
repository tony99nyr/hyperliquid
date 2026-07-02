# The Pro-Desk Ladder Playbook (operator methodology)

How a disciplined desk turns a *thesis* into a *risk-defined, executable ladder* on this
cockpit. This is the **operator method**; the system design lives in
[`ARMED_LADDER_ARCHITECTURE.md`](./ARMED_LADDER_ARCHITECTURE.md), the operational steps in
[`LADDER_OPERATOR_RUNBOOK.md`](./LADDER_OPERATOR_RUNBOOK.md), and the locked decisions in
[`adr/`](./adr/). Read those for *how it fires*; read this for *what to build and why*.

> One sentence: **define the most you can lose first (net of slippage and funding), start
> small, let price earn more size, scale out into strength, and never average down.**

> This playbook was hardened by an adversarially-verified expert panel (institutional risk,
> crypto-derivatives execution, quant volatility, trading process, crypto tail-risk). Where
> a claim is an engine fact it cites the module; where it is operator discipline the engine
> does **not** enforce, it says so explicitly — do not assume the system is catching it.

> **Close the loop.** Every terminal ladder resolves into the outcome LEDGER and the weekly
> **`ladder-expectancy`** review (KILL / HOLD / SIZE-UP / COLLECT per setup type against a
> pre-registered bar — `pnpm skill:ladder-expectancy`). A SIZE-UP earns ONE risk-tier step;
> a KILL is a standing stop-trading-this-setup instruction. Without this loop you cannot
> tell skill from luck.

> **Grade what you build.** That same panel is wired up as the **`review-ladder`** skill
> (`pnpm skill:review-ladder [--ladder <id>] --equity <usd>`): it scores a draft or open
> ladder 0/10 on RISK and UPSIDE pillars and flags hard blockers. Use it as the build
> checklist and before every arm — but it never arms (advisory only). Aim for RISK ≥ ~7 with
> no blockers; a clean risk score on a weak thesis is still a bad trade (the Thesis pillar).

---

## 0. When a ladder is the right tool

Use a ladder when you have a directional thesis but **timing/level uncertainty** — you want
exposure to scale with confirmation rather than committing all size at one price. Do NOT use
one to "set and forget" a weak idea: a ladder is a disciplined *execution* of a thesis you
can defend, not a substitute for the thesis.

## 1. Operating principles (the non-negotiables)

1. **Risk-first, not size-first.** Decide the campaign's *maximum loss* (a fixed % of
   account, **net of slippage + funding** — see §4) before any price or size. Everything
   else is derived from it.
2. **Pyramid into strength, never average down.** Add only after the move proves the thesis
   and the existing position's profit covers the new rung's risk *at the moment of the add*.
   The engine enforces this (`ladder-fire-service.ts` add-guard); treat it as your own rule,
   not a constraint to route around. The guard protects you only at the instant of the add
   **and only if you also tighten the core stop** — a fast reversal right after an add can
   still redden a campaign that had a green core.
3. **A stop is a market-on-trigger order, NOT a guaranteed price.** HL stops fire at market
   on the mark with up to **10% slippage tolerance** (`STOP_SLIPPAGE_TOL = 0.1` in
   `ladder-risk-business-logic.ts`). Your realized worst case is the **slipped** loss the
   preview shows. An HL stop slips up to **10% of price**, so the loss multiplier is
   `slippedRiskUsd ≈ riskUsd × (1 + 0.10/stopFrac)` — for a *tight* stop this is FAR more
   than ×1.1 (a 14% stop → ~×1.7; an 8% stop → ~×2.2). On a gap it is larger still.
   Never quote the clean stop price as your worst case.
4. **The aggregate stop only ever tightens — but pre-size for vol expansion.** Never widen a
   stop to "give it room." Because you cannot widen later, set the *initial* stop off the
   higher of current and a stress ATR, and size notional down to afford it. If realized vol
   expands past that after entry, the correct move is to **reduce size**, never widen the stop.
5. **Scale out into strength — knowing it lowers expectancy.** Banking partial profit and
   trailing to break-even *reduce variance AND reduce expected value* (they truncate the
   right tail a trend trade lives on). Do it when continuation odds have dropped (resistance,
   divergence, regime shift), **not mechanically**. See §1.4a.
6. **Every entry is bracketed — but only the native stop is intrabar + offline-proof.** A
   native HL stop rests atomically with each open/add fill and survives you/Claude being
   offline. **Everything else** — adds, scale-out (`reduce`) and `close` rungs — is
   watcher-dependent: it fires only on a completed 15m candle via the external scheduler. A
   dead watcher silently stops firing those rungs while your stop still protects you — so an
   **external dead-man's-switch (healthchecks.io) now pages you** if the ladder-watch cron
   stops pinging (`LADDER_WATCH_HEALTHCHECK_URL`; see §6). Still confirm it's wired in prod.
7. **Decreasing size per rung.** Later adds are smaller, keeping the blended entry near the
   first rung.
8. **Isolated margin, always.** Size and liq math here assume **isolated** margin per coin
   (the engine's `isolatedLiqPx` model, `leverage-business-logic.ts`). Set HL to isolated;
   under cross margin a position's liq line floats with total equity and this buffer math
   does not apply.
9. **Account-level halts (operator-enforced).** Per-campaign limits are not enough. Stand
   down on: a **daily** realized loss ~4% / **weekly** ~8% of equity (no new arms until
   reset); **3 consecutive losing campaigns** → half size + Conservative-only until a winner;
   a **15% account drawdown** → flatten/disarm and review before re-engaging. The
   account circuit-breaker (ADR-0007) blocks *new entries* at the account level, but these
   de-grossing rules after drawdown are **yours to enforce** — the ladder engine does not.

## 1.4a Expectancy & the scale-out tension

For a desk methodology, name the edge: `R` = a rung's `riskUsd` (loss at the slipped stop).
A campaign only earns its keep if expected payoff clears the **funding + slippage haircut** —
roughly, aim for a blended **≥ 1.5R** to the first meaningful target before arming. The
honest tension: §1.5's scale-out and §1.2's break-even *lower* expectancy. In a clean,
higher-TF-aligned momentum regime, a single well-sized core held to a structural target often
beats the laddered version. Ladder when timing is *uncertain*; concentrate when it isn't.
(No fixed win-rate gate — just don't pretend a heavily-scaled, BE-trailed plan is high-EV.)

## 2. The 8-step desk process

1. **Thesis** — one sentence with an explicit invalidation level ("long HYPE; thesis dead on
   a daily close below ~$57").
2. **Grade the signal** — if following a trader, grade the wallet first (`analyze-traders`;
   the INSUFFICIENT_HISTORY gate). A ladder on a bad signal is a tidy way to lose money.
3. **Regime read** — `analyze-market-timeframes`. Note alignment and divergence. A bearish
   divergence on the entry TF → *smaller core, more confirmation before adds*. **Adds are
   only permitted in a trending/expansion regime** — in a range, `price_above` adds buy the
   top; trade core-only with scale-outs instead.
4. **Funding check** — read the current funding rate + recent trend. Funding is a carry cost
   on every held/added rung (charged hourly on HL) and is **not** inside `maxTotalLossUsd`.
   A deeply adverse funding flip is a partial thesis-invalidation.
5. **Event check** — before a multi-day alt campaign, scan the **token-unlock / emission
   calendar**, listings/delistings, and any dated catalyst inside the expiry window. A large
   unlock against your direction is a no-trade or size-down. (Pre-known supply shocks gap
   alts *through* stops.)
6. **Risk budget** — pick the campaign max-loss % from the tier (§5), convert to dollars,
   then split it across rungs (§4). Confirm book-level heat (§5b).
7. **Construct the ladder** (§3, §4) — rungs, triggers, stops, scale-outs, caps, expiry.
8. **Arm & monitor** — review in the preview/arm modal, arm with the typed approval, let the
   watcher fire. Re-check on cadence; run the §11 checklist when it goes against you.

## 3. Ladder anatomy (mapped to the cockpit rung model)

A ladder is a list of **rungs**, each a `{deterministic trigger → pre-authorized order}`:

| Rung role | `action` | Typical `triggerKind` | Intrabar? | Notes |
|---|---|---|---|---|
| **Core entry** | `open` | `price_above` (long), or at-market | close-gated | Small; the toe in the water |
| **Pyramid add** | `add` | `price_above` (long) | close-gated | Fires *only if in profit* (add-guard); smaller; trending regime only |
| **Scale-out** | `reduce` | `price_above` (long) | close-gated | Banks gains; **misses wick highs** (see below) |
| **Structural exit** | `close` | `price_below` (long) | close-gated | A backstop, **NOT an intrabar stop** |
| **Protective stop** | (native bracket) | rests with the fill | **intrabar** | The only thing that fires on a wick / while offline |

**Trigger ≠ fill.** `open`/`add` rungs fire at the **15m candle-close mark**, not the trigger
price, so the actual entry/stop/`sizeCoins` drift from the level you typed (only `riskUsd`
and notional are invariant). Treat the level prices as triggers, not fills.

**Watcher rungs lag and act on the close.** The watcher evaluates the **last completed 15m
candle** (`candles[len-2]`) on a ~2-min tick, so a rung can lag a fast move ~17 min and acts
on the *close*, not the level. Consequences the operator must internalize:
- The `close` `price_below` rung gives **no intrabar protection** — only the native resting
  stop fires on a fast flush. Never use a `close` rung as your stop.
- A `reduce` scale-out into resistance will **miss a spike-and-reverse** that doesn't close
  through. For profit you must capture at a level, use the **native bracket TP**, or trim
  manually — don't trust the close-only rung to catch the high.

Each `open`/`add` rung is **risk-sized**: you supply `riskUsd` + `stopFrac` (+ `leverage`),
and the server computes `sizeCoins = riskUsd / (mark · stopFrac)` at fire time; the
protective stop rests atomically with the fill.

**Sizing a `reduce`/`close` rung — prefer `reduceFrac` over absolute `sizeCoins`.** An
absolute `sizeCoins` trim is *path-dependent*: "shed 0.5 coins" is 40% of a position if the
add filled but ~80% if it didn't. Set **`reduceFrac` (0,1]** instead — it trims that fraction
of whatever is *actually* open at fire time, robust to which entry rungs filled. (`close`
always exits 100%.)

## 4. Position sizing math

**Step 1 — campaign budget (top-down):**
```
campaignRiskUsd = accountEquity × campaignRiskPct      # the most the WHOLE ladder may lose
```
**Step 2 — split across rungs.** `campaignRiskUsd` is the **sum** of every `open`+`add`
rung's risk-at-stop, NOT the per-rung figure:
```
Σ rungRiskUsd  (over all open + add rungs)  ≤  campaignRiskUsd
```
> Pitfall the engine will NOT catch: `riskUsd` is a **per-rung** input. If you set each rung's
> `riskUsd` to the full campaign budget, a 2-rung ladder risks 2× what you intended, a 3-rung
> ladder 3×. Always budget top-down, then divide.

**Step 3 — size each rung off its stop:**
```
notionalUsd   = rungRiskUsd / stopFrac                 # stopFrac sized off structure/ATR first
sizeCoins     = notionalUsd / entryPx
aggLeverage   = Σ notionalUsd / accountEquity          # the tier leverage cap applies to this AGGREGATE
```

**Liquidation-aware check (corrected).** Liquidation fires at **maintenance margin**,
*sooner* than `1/leverage`. For an isolated position the liq distance ≈ `1/L − MMR`
(`MMR ≈ 0.4%`, `isolatedLiqPx` in `leverage-business-logic.ts`), and the relevant `L` is the
**per-coin leverage SETTING** (`rung.leverage`), *not* `notionalUsd/equity`. Because the stop
is market-on-trigger, the binding constraint is the **slipped** fill:
```
(1 + 0.10) · stopFrac  ≤  1/L − MMR            # the stop must clear liq on its WORST fill
practical rule:  stopFrac ≤ ~0.7 × (1/L)
```
Idle equity in the account does **not** widen an isolated position's liq line — only the per-coin
leverage setting does. Pull the real liq price from the account-risk read rather than the
rule of thumb when in doubt.

**Costs are part of max-loss.** `maxTotalLossUsd` and your "worst case" must be net of:
```
effectiveLoss ≈ Σ rungRiskUsd × (1 + 0.10/stopFrac)   # 10% slip is 10% OF PRICE → the
                                                      # multiplier blows up for tight stops
              + roundTripFees
              + expectedFunding                       # = notional × fundingRate × hoursHeld, hourly
```
The engine's `computeLadderRisk` applies the 10% slippage haircut **and now folds estimated
funding into the loss cap at arm time** — the arm route fetches each coin's current hourly
funding, extrapolates it over the arming window (per-coin, floored at 0 so a credit on one
coin can't mask a cost on another, and clamped to a sane band so a transient spike can't
falsely block the arm). So an arm whose stop loss **+ funding** exceeds `maxTotalLossUsd` is
now refused. **Fees are still on you to budget**, and funding is an estimate over the *arming*
window (not the eventual hold) — if funding is a large share of the budget, shorten the
expiry or size down.

**Wick tax.** Size the stop off structure/ATR (e.g. beyond the recent wick extremes / a named
swing, ~`k·ATR` with `k ∈ [1.5, 2.5]`), then derive notional — never pick a round % first, and
never place the stop *on* obvious liquidity (round numbers, prior swing lows) where it gets hunted.

## 5. Risk tiers (presets)

| Tier | Campaign max-loss | Aggregate eff. leverage | Stop discipline |
|---|---|---|---|
| **Conservative** | ~1–2% of account | ≤ ~0.5× (spot-like) | Wide stop off weekly structure; small core |
| **Moderate** | ~2–3% | ~1–2× | Stop off daily structure |
| **Aggressive** | ~3–5% | **via a smaller core, not more leverage** | Structural (not tight) stop |

> **Tight stops and high leverage are mutually exclusive on high-vol alts.** A tight stop sits
> inside ATR (wick tax) *and* high leverage shrinks the liq buffer, so the slipped stop fill
> lands past liquidation. "Aggressive" means more risk-% via a **smaller core at a structural
> stop**, never via cranking leverage on a tight stop.
>
> **A small account (< ~$1k) on a high-vol alt: Conservative is the ceiling, not the floor**,
> and cap aggregate effective leverage ≤ ~2× regardless of tier.

## 5b. Portfolio heat (the book-level cap — operator-enforced)

The engine sizes and caps **each ladder in isolation**; it does **not** aggregate risk across
ladders. That is the classic small-account blowup: three "Conservative" 2% alt-long ladders are
*not* three independent 2% bets — crypto alts carry high BTC-beta, so in a flush they stop out
together for ~6% in one candle. Before arming a new ladder, sum `maxTotalLossUsd` across every
armed + live ladder and enforce, **manually**:
- total open campaign risk across all ladders ≤ **6%** of equity;
- summed risk within a correlated cluster (all alts, or all longs) ≤ **4%** — count
  same-direction alt ladders as **one** position;
- max **one** active campaign per coin and **≤ 3** concurrent campaigns on a < $1k account.

The rubric portfolio-beta cap (ADR-0006) and the circuit-breaker (ADR-0007) are the
related enforcing layers, but they do not replace this manual sum.

## 6. Engine guardrails — and their honest limits

**What the engine enforces for you:**
- **No averaging-down adds** — an `add` is refused unless its worst-case loss is covered by
  current unrealized profit.
- **Atomic brackets** — a fill that can't be bracketed is flattened (filled-but-unstopped is a
  hard fault).
- **Caps + expiry** — `maxTotalNotionalUsd`, `maxTotalLossUsd` (10%-slippage-adjusted) and a
  mandatory expiry bound the campaign; precondition drift auto-disarms.
- **Kill-switch + paper default** — `LADDER_AUTOFIRE_ENABLED` and paper mode mean nothing fires
  until you explicitly enable it.

**What it does NOT protect against (you must):**
- **Gaps through the stop** — a > 10% gap can blow past both the stop and the 10% slippage band;
  the market-on-trigger order can rest unfilled until price re-enters the band, leaving you
  effectively **unprotected** until then. The native stop is your worst exit on a true cascade,
  not your best.
- **Thin liquidity windows** — weekends, holidays, ~00:00–06:00 UTC: worse slippage and wicks.
  Cut size or avoid arming new entries into them.
- **Dead watcher** — adds / scale-outs / `close` rungs silently stop firing if the external
  scheduler dies. Only the native stop is watcher-independent. An external healthchecks.io
  dead-man's-switch (`LADDER_WATCH_HEALTHCHECK_URL`, Period 5 min / Grace ~13 min) pages you
  when the cron stops pinging — confirm it's wired in prod, and still spot-check the watcher
  is ticking before relying on a scale-out/add.
- **Venue / oracle / collateral risk** — a native stop does NOT protect against HL
  auto-deleveraging, an oracle/mark wick triggering it off real price, venue downtime, or a
  USDC-collateral depeg (which cuts equity *and* can cascade liquidations). **Don't hold your
  whole bankroll on one venue** — single-venue concentration bypasses every stop here.

## 7. Worked example — HYPE long, $980 account, conservative

Live HL mid ~$65.8 (re-check before arming — secondary price feeds lagged to $58–62 during the
late-June correction). Context from verified research: HYPE ran ~$21→$76.70 ATH (Jun 16) then a
~14–18% pullback with a **4h double-top**; support stacks at $64.8 / $62 / $60 / **$58.4**, so the
stop belongs **below the $58.4 shelf**. *Event check:* the **Jul 6 unlock is a routine ~$10–30M
monthly vest, NOT a cliff** (the "$565M unlock" headline was false) — the 7-day window is clear of
a supply bomb. *Carry/floor caveats:* the fee-funded **buyback is procyclical and weakening
(~−40% over two quarters) — do NOT size as if it is a floor under you.**

Campaign budget: at-stop `≈ $10 (~1%)` — but the engine's no-netting **slipped** worst case is
the binding number (see below), so size to that.

| # | Action | Trigger (≠fill) | rungRiskUsd | Stop (isolated) | ~Notional | Purpose |
|---|--------|-----------------|-------------|-----------------|-----------|---------|
| 1 | open (core) | ~$66.0 | $6 | ~$56.5 (−14%, below $58.4 shelf) | ~$42 | Toe in; core alone is a coherent trade |
| 2 | add (pyramid) | price_above **$72.0** | $3 | ~$66 (re-bracket on add; **static otherwise — no live trailing**) | ~$36 | **Smaller than the core** (decreasing-size rule — a tighter stop would size it BIGGER for equal risk, which arm rejects); fires only if rung 1 green *and* you tighten the core; $72 also invalidates the double-top |
| 3 | reduce (`reduceFrac` 0.4) | price_above $74.5 | — | — | — | Bank 40% of the LIVE position into prior-ATH resistance (close-only; may miss a wick — manual trim / bracket TP) |
| 4 | reduce (`reduceFrac` 0.4) | price_above $80.0 | — | — | — | Trim 40% of the remainder on the ATH-breakout extension |

Leverage setting: **2×** per coin (1/L = 0.50; the −14% core stop, even slipped, clears the ~46%
liq line with huge margin). Caps: `maxTotalNotionalUsd ≈ $100`, aggregate eff. leverage ≈ 0.08×.
**Honest worst case (the cap MUST clear this, or the ladder won't arm):** at-stop the rungs total
~$9, but each stop slips **10% of price** — core $6×(1+0.10/0.144)≈$10, add $3×(1+0.10/0.083)≈$7 —
so the no-netting SLIPPED worst case ≈ **$16** (funding negligible here, ~$0.2). Set
`maxTotalLossUsd ≈ $20`. The at-stop figure ($9) is **not** the cap — a tight-stop ladder slips
far more than ×1.1. Both legs can't lose full risk at once (the add fires only once the core is
green + re-bracketed), so ~$16 is the conservative cap surface, not the expected path. Best case:
pyramided into a confirmed trend on house money, scaling out into strength.

## 8. When the thesis half-breaks (dead-zone rules)

Most behavioral losses happen in the ambiguous middle — price above your stop but the *reason*
is gone. The plan for being wrong matters more than the entry plan:
- **Thesis-break ≠ stop-hit.** If the reason you entered is gone — structure lost on the entry
  TF or a higher TF, the flagged divergence confirms against you, the copied leader exits/flips,
  funding flips hard against you — **disarm and manually exit now**. Riding a known-dead thesis
  to the mechanical stop is a discipline failure, not patience. *(The copied-leader case is now
  AUTO-ENFORCED: tag the ladder with `leader_address` and the leader guard auto-disarms it when
  the trader-watch feed shows a close/flip after arming — disarm-only, it never fires.)*
- **Time-stop.** If the core hasn't moved toward the first add trigger by ~50% of time-to-expiry
  and isn't in profit, disarm pending adds and reassess — a thesis that isn't working is wrong
  even if it isn't yet losing. *(The watch daemon now fires a `time-stop` advisory when an open
  position is >5 days old without reaching +1% of notional — it alerts, you decide.)*
- **A skipped add is the system working, not a failure.** The coverage gate skips an add
  (permanently — each rung is one-shot) whenever you're not in enough profit. **NEVER manually
  buy in to replace a skipped add** — chasing a rung the gate refused is martingale by hand.
  This is why the **core alone must be a coherent standalone trade**; adds are a bonus, not the plan.
- **Break-even procedure (no live trailing today).** Once the position reaches +1R *or* the
  first scale-out fires, tighten the aggregate stop to at least break-even — **manually**, from
  Open Positions (cancel/replace the resting bracket). Place BE just below the breakout level /
  last higher-low, not exactly at entry, to survive a retest. The stop is **static** between rung
  events; if you want it to follow price, you move it.
- **On a half-break you may only TIGHTEN, SCALE OUT, or EXIT** — never add, never widen.

## 9. Anti-patterns (do not do these)

- **Martingale / averaging down** — adding to a loser to lower the average. Engine-refused; never
  route around it by hand (see the skipped-add rule, §8).
- **Size-first sizing** — picking notional/leverage and discovering the risk after.
- **Treating the stop price as the worst case** — it's a market-on-trigger; budget the slipped fill.
- **Stop inside the liquidation buffer after 10% slip + funding** — it must clear liq on its worst fill.
- **Paying punitive funding to hold a crowded directional bet.**
- **Relying on a `close` rung or a `reduce` scale-out for intrabar protection / catching a wick.**
- **Stacking correlated alt ladders past the §5b book heat cap.**
- **Chasing into a divergence with full size; no expiry / no invalidation.**

## 10. Pre-arm checklist

- [ ] Thesis written with an explicit invalidation level.
- [ ] Signal graded (if copying a trader).
- [ ] Regime + divergence read done; **regime supports adds** (trending), else core-only.
- [ ] Funding rate + trend checked; carry budgeted into max-loss.
- [ ] **Event check** — no major unlock/emission/dated catalyst inside the expiry window (or size cut).
- [ ] Campaign max-loss set as a % of account, **in dollars, net of slippage + funding**;
      `Σ rungRiskUsd ≤ campaignRiskUsd`.
- [ ] Margin mode = **isolated**; every `open`/`add` has a stop with `(1.1·stopFrac) ≤ 1/L − MMR`.
- [ ] Stop sits beyond obvious liquidity (a named structure level / ATR multiple), not a round %.
- [ ] Adds confirmation-based (`price_above`), decreasing in size; **core alone is an acceptable trade**.
- [ ] Scale-outs defined (knowing they're close-only); must-capture profit on a bracket TP.
- [ ] **Book heat** (§5b) re-summed across all armed/live ladders ≤ caps; account not in a halt (§1.9).
- [ ] Caps + expiry set; reviewed in the arm modal; armed with the typed approval.

## 11. When it goes against you (run this — don't improvise)

- [ ] Is the original **reason** still intact? If no → disarm + manual exit **now** (don't wait for the stop).
- [ ] Eligible to tighten (≥ +1R or first scale-out fired)? → move the stop to break-even (manually).
- [ ] Is the **watcher ticking** (so scale-outs/adds can fire)?
- [ ] Did an **add skip**? → do nothing; do NOT manually add.
- [ ] Within total-account **heat** (§5b) and not in an account **halt** (§1.9)?
- [ ] Has expiry / your **time-stop** passed with no progress? → disarm pending rungs.
- The only on-trade actions allowed: **tighten, scale out, or exit** — never add, never widen.
</content>
