# Ladder Builder Guide — everything an agent needs to create ladders

**Audience: an agent (Claude session) asked to build, review, or amend Armed Ladders.**
This is the practical companion to [ARMED_LADDER_ARCHITECTURE.md](./ARMED_LADDER_ARCHITECTURE.md)
(design rationale), [LADDER_OPERATOR_RUNBOOK.md](./LADDER_OPERATOR_RUNBOOK.md) (operating it),
[LADDER_DESK_PLAYBOOK.md](./LADDER_DESK_PLAYBOOK.md) (trading judgment), and
`src/lib/ladder/CLAUDE.md` (code-modification rules). Read this FIRST when the task is
"make a ladder"; read the code CLAUDE.md before *changing* the engine.

> ⚠ **These are LIVE-MONEY plans.** `TRADING_MODE=live` in production, autofire is ON,
> and a `mode:'live'` ladder fires real orders on the production watcher. You (the agent)
> draft; **only the operator arms** (typed phrase `arm <id8>`). Never attempt to arm,
> never weaken a validation to make a draft pass, and never create `mode:'live'` unless
> the operator asked for a real ladder.

---

## 1. Mental model + lifecycle

A ladder is a **pre-authorized multi-rung plan**: each rung says *"when X prints on a
COMPLETED 15m candle, do Y"*. A deterministic watcher (Vercel cron, poked every ~2–5 min)
evaluates armed rungs against the last completed candle and fires the ones whose
condition is met, through a fail-closed guard stack (kill-switches, mode-match,
precondition re-check, atomic one-shot claim, atomic stop bracketing).

Lifecycle: `draft` → (operator types the phrase) → `armed` → rungs fire/skip/fail →
`done` (all rungs terminal) | `expired` (past `expires_at`) | `disarmed` (guard/OCO/
operator). `archived_at` hides old drafts from the list (audit-preserved).

Key engine facts you must design around:

- **Triggers evaluate on 15m COMPLETED closes** (`candles[len-2]`) — never the
  in-progress bar, never intrabar touches. A wick through your trigger does nothing;
  a close through it fires on the next watcher tick (≤ ~5 min later).
- **Fills happen at the market AFTER the close** — the fill overshoots the trigger.
  Entry/stop/size drift from the previewed values, but `riskUsd` and notional
  (`riskUsd/stopFrac`) are fill-invariant. Quote geometry accordingly.
- **Every open/add is bracketed atomically** with a resting reduce-only stop derived
  from `stopFrac` × the actual fill price (and `targetPx` if set). A bracket reject
  flattens the fill (never filled-but-unstopped).
- **The consent risk model assumes stops fill 10% of price worse** (worst case =
  `riskUsd × (0.9 + 0.10/stopFrac)`). Tight stops are punished hard: a 1% stop shows an
  ~11× worst-case multiple. Structural 2.5–5% stops price honestly.
- **Mode-match:** the production watcher fires `mode:'live'` ladders only. A
  `mode:'paper'` ladder never fires in prod (no paper watcher runs) — it just sits.

---

## 2. `createLadder` reference (the full input surface)

Create via a one-off script (scripts have no dotenv — use the loadEnv pattern):

```ts
import { readFileSync } from 'node:fs';
import { createLadder } from '@/lib/ladder/ladder-service';
function loadEnv(){/* parse .env.local into process.env — see any scripts/_*.ts example */}
const id = await createLadder({
  title: 'BTC breakdown short v2 — panel-amended',
  thesis: '...the CONTRACT (see §6)...',
  author: 'operator',            // 'scout' is forced paper by a DB CHECK
  mode: 'live',                  // 'paper' never fires in prod
  ocoGroupId: null,              // share one uuid across a straddle's two ladders
  leaderAddress: null,           // set to a wallet to enable the leader-guard auto-disarm
  maxTotalNotionalUsd: 150,      // REQUIRED to arm
  maxTotalLossUsd: 19,           // REQUIRED to arm
  expiresAtMs: Date.parse('2026-07-17T20:00:00Z'),  // REQUIRED to arm
  activeFromMs: null,            // optional activation window start (see §4)
  rungs: [ /* NewRung[] — see below */ ],
});
```
Run: `pnpm tsx --tsconfig tsconfig.scripts.json scripts/_yourscript.ts` (then delete it).

**NewRung fields:**

| Field | Used by | Meaning |
|---|---|---|
| `seq` | all | Display/order (1-based). |
| `coin`, `side` | all | Uppercase coin; `side` is the POSITION side (a reduce on a long is `side:'long'`). |
| `action` | — | `'open' \| 'add' \| 'reduce' \| 'close' \| 'stop_move'` (§3). |
| `triggerKind` | — | `'price_above' \| 'price_below' \| 'volume' \| 'indicator'` (`'funding'` exists but is REJECTED at arm — nothing publishes it yet). |
| `triggerPx` | price kinds | The level a 15m close must cross. |
| `triggerMeta` | volume/indicator/extras | See §4. |
| `riskUsd` + `stopFrac` | open/add | THE sizing: notional = riskUsd/stopFrac, stop = fill × (1∓stopFrac). Explicit `sizeCoins` on open/add is IGNORED at fire (parity rule). |
| `reduceFrac` | reduce | Fraction (0,1] of the CURRENT live position — path-independent (survives earlier partial fills). Prefer over `sizeCoins`. |
| `sizeCoins` | reduce/close | Absolute trim size (else null = full for `close`). |
| `leverage` | open/add | ≥1, ≤ the coin's HL max (validated). |
| `stopPx`/`targetPx` | open/add | Optional explicit bracket levels (else derived from stopFrac). |

---

## 3. Rung actions

- **`open`** — establishes the position when flat (or the first rung of a campaign).
  Requires `riskUsd`, `stopFrac`, `leverage`. Must carry a protective stop on the loss
  side (validated).
- **`add`** — pyramids INTO A WINNER only: at fire, `addRiskCoveredByProfit` requires the
  add's worst-case loss to be covered by current unrealized profit (anti-martingale; a
  flat/losing position skips the add). Arm-time pyramiding guardrails: adds must have
  DECREASING size and TIGHTENING stops vs the prior rung. An add's own bracket usually
  lifts the campaign's protection (design your add stopFrac so its stop ≈ the earlier
  rung's breakeven).
- **`reduce`** — banks profit, reduce-only, sized from the LIVE position at fire
  (prefer `reduceFrac`). Can never flip a position.
- **`close`** — full reduce-only close.
- **`stop_move`** — **the ratchet** (no order except stop management): when its price
  trigger prints, the position's RESTING exchange stop moves to `triggerMeta.moveTo`
  (a price, or `'breakeven'` = live avg entry at fire). RISK-REDUCING ONLY, enforced
  at arm (destination on the protective side of the trigger) and at fire (tighter than
  the current stop; protective vs the fresh mark — else skips). New stop is placed
  BEFORE the old is canceled (never unstopped). Contributes $0 to arm-time worst case.
  **Arm ratchet ladders only AFTER the position exists** (a ratchet armed against a
  flat coin auto-disarms with `precondition-drift` when the position appears).
  UI renders these amber with a 🔒. `moveTo:'trail'` + `trailDistancePx` = a TRUE
  TRAILING ratchet: each completed candle beyond the trigger, the stop follows the
  mark by the distance (only ever tightens; the rung stays PENDING and re-fires per
  candle until expiry or a flat position — trail rungs claim per-candle, not one-shot).
  Prefer trail over stacked fixed ratchets for trend exits (the Jul-15 lesson: fixed
  +1.2R triggers never arm on +0.7R moves).

---

## 4. Trigger extras (`triggerMeta`) + ladder-level windows

- **`momentumConfirm: true`** (+ `momentumMaxFlips: 0..2` default 0, + `momentumSustain:
  1|2` default 1 — sustain 2 also requires the PREVIOUS candle's read clean, filtering
  one-candle head-fakes like the Jul-15 BTC top-tick fill; recommended for breakouts) — on
  price-triggered **open/add ONLY**: the entry fires only when the momentum-stall
  composite shows ≤ maxFlips signals AGAINST the direction (volume fade / CVD
  non-confirmation / book-against, computed from live candles + the recorded
  `market_snapshots` series). Missing momentum data FAILS CLOSED (no entry on blind
  data). This mechanizes the flow checklist — use it on breakout entries so you don't
  buy a close the tape is fading.
- **`indicator` trigger kind** — **EXIT-ONLY** (reduce/close): fires when a published
  indicator crosses `indicatorValue` per `op`. Published names (SSOT in
  `ladder-types.ts`): `momentum-stall-long`, `momentum-stall-short` (value = 0–3
  signals flipped against that side). Must be side-consistent (long exits watch
  `-long`). Optional `floorPx` = "exit on stall, but only beyond this price" (long:
  close ≥ floorPx; short ≤). Example — bank when momentum dies but only in profit:
  `{ action:'reduce', triggerKind:'indicator', reduceFrac:0.5, triggerMeta:{ op:'above', indicatorName:'momentum-stall-long', indicatorValue:2, floorPx:67 } }`
  NOTE: our exit-policy backtest says dynamic exits ≈ wash vs fixed banks — offer as an
  option, not a default.
- **`moveTo`** — stop_move destination (see §3).
- **`minVolume`** — `volume` trigger kind: completed-candle volume ≥ threshold.
- **Activation window (ladder-level `activeFromMs`)** — an ARMED ladder's triggers
  evaluate only inside `[active_from, expires_at]`. Purely restrictive. USE FOR EVENT
  STRADDLES: draft + arm at leisure; set `activeFromMs` ≈ print − 15 min so gates can't
  fire on pre-print wander. Empty windows (active_from ≥ expiry) are rejected at arm.

---

## 4b. Fire-time exposure gates (automatic — no rung config)

Every LIVE open/add passes two gates BEFORE the claim (skips are retryable; reduce/
close/stop_move are NEVER gated): (1) the LIVE circuit breaker — a daily-loss/drawdown
trip freezes autonomous entries account-wide; (2) the BOOK-HEAT ceiling — slip-aware
worst case of all open positions + this rung must stay under `LADDER_BOOK_HEAT_MAX_FRAC`
(default 10%) of live equity. Unstopped positions are priced punitively in the heat sum.
Both fail CLOSED on unreadable account state. Design ladders assuming the gate exists:
an over-heated book silently skips your entry until room frees up.

## 5. What the arm validation will REJECT (build to pass honestly)

Missing title/rungs/expiry/caps · expiry in the past · empty activation window ·
price triggers without positive `triggerPx` · open/add without entry/size/leverage/stop ·
stop on the wrong side of entry · leverage > coin max · adds that grow (size must
decrease) or loosen stops · `funding` triggers (unsupported) · `indicator` on open/add ·
unknown/side-inconsistent indicator names · `momentumConfirm` on non-price or non-entry
rungs · `stop_move` without a price trigger or valid protective `moveTo` · caps below
the computed worst case (breach warnings). **Never "fix" a rejection by weakening the
rung — fix the geometry.** The arm route re-validates server-side from the persisted
row; a warning list means NOT armable.

---

## 6. Desk process rules (as binding as the code)

1. **Every new ENTRY thesis gets a 4-skeptic adversarial panel** before it's presented
   (event-risk / technician / quant / flow lenses — see memory `adversarial-panel-for-ladders`).
   Reduce-only bank renewals with unchanged thesis skip the panel.
2. **Price BOTH structures**: graded (starter + adds at confirmations — the default
   offer at medium risk) AND conservative (single confirmation gate). The operator picks.
3. **Risk tiers** (operator-set, medium): campaign risk ~$8–10 (~1% of equity), worst
   case ≤ ~2.5%, book heat (OCO counted once) ≤ ~5%. Floor tier $4–5 for unproven setup
   types (COLLECT). SIZE-UP only when the ledger says so (n≥10 closed, ≥+0.15R).
4. **No entry trigger armed through a binary print** (CPI/FOMC/PPI/testimony). Use
   activation windows to go hot post-print, or the event-straddle template (§7).
   Reduce-only ladders MAY run through binaries. Filled positions may ride them per
   playbook §8 judgment; pending ADD rungs are entry-class — disarm across the window
   if price is near the add trigger.
5. **One macro bet at a time**: never a second entry ladder armed while another is
   FILLED (OCO straddle pairs count as one bet).
6. **Structural OCO straddles: re-arm-on-stop-out** (if one side fires and stops, the
   auto-disarmed sibling gets re-presented). **Event straddles: plain OCO** — the
   backtest showed re-arm SUBTRACTS on event days.
7. **Geometry hygiene** (the scorecard checks these): triggers/stops OFF round numbers
   (≥0.15% away) and outside recent wick pools; stops STRUCTURAL (where the thesis
   dies), not just "wide"; targets in FRONT of known supply/demand walls and inside the
   measured move; side-aware R:R (first target ≥ ~1.2R at floor size, better with a
   ratchet); ratchet-before-add sequencing.
8. **The thesis field is the contract.** Write it for the next agent: the setup type
   (ledger name), the evidence with numbers, every panel amendment, the standing
   orders (re-arm rules, BE ratchets, arm windows, checklists), and the invalidation.
9. **Log outcomes**: every closed campaign gets a `ladder_outcomes` row under its
   pre-registered setup type; never invent a new bucket to dodge a kill bar.

---

## 7. Recipes (real ladders shipped by this desk)

**Graded reclaim long** (HYPE `804c2a5c`): open $5 on 15m close > 64.62 (stop −3.47%) →
add $4 > 66.85 (its bracket ≈ starter breakeven) → reduce 0.5 @ 67.15 → reduce 0.5 @ 70.80.

**Breakdown short, confirmation-gated** (BTC `d18498ed`): open $4 below the broken
floor (gate 0.6–1% under multi-tested lows, off rounds), structural stop above the
re-acceptance zone, banks above the next demand shelves, expiry BEFORE the next binary.

**OCO straddle** (HYPE `804c2a5c` + `e4d2c33b`): two ladders, opposite sides, shared
`ocoGroupId`; gates bracket a dead zone (chop = $0); asymmetric sizing toward the
higher-conviction side; re-arm-on-stop-out standing order (structural version).

**Breakeven ratchet** (`f4ad8ac1`): single `stop_move` rung, trigger just BELOW the
campaign's add level, `moveTo:'breakeven'` — the campaign locks risk-free before it
grows. Armed only after the position existed.

**Event straddle template** (graduated 2026-07-14, ledger `event-straddle`): OCO pair,
gates ±1.0% (majors) / ±1.5% (HYPE/SOL) from the pre-print reference close, stop at the
reference, 24h time exit, floor $4–5/side, `activeFromMs` = print − 15 min, plain OCO.
LESSONS (Jul 15, first live run): build the management rungs INSIDE each leg (a
single-open leg completes at fill and orphans its position); ratchet triggers belong at
~+0.6–0.8R (a +1.2R trigger never armed on a +0.7R move); event fills are fade-prone by
construction → include a momentum stall-exit rung (indicator ≥2, NO floorPx — cut the
fade even slightly underwater; the impulse dying = the thesis dying).

---

## 8. Tooling

- **Score every draft**: `pnpm skill:review-ladder --ladder <id> --equity <usd> --signal <0-10> --timing <0-10>`
  (0/10 RISK + UPSIDE scorecard; warnings there = fix the geometry). Blockers gate arming.
- **Expectancy ledger**: `pnpm skill:ladder-expectancy` (+ `--resolve` flows) — the judge.
- **Arm/disarm**: operator-only, cockpit UI or `POST /api/cockpit/ladder/arm` with the
  typed phrase. Disarm: `POST /api/cockpit/ladder/disarm`.
- **Hit notifications**: fires 🔥, banks 💰, ratchets 🔒, faults 🚨, exchange-side stop
  fills 🛑 all page Discord automatically.
- **After any engine change**: `pnpm validate`, and read `src/lib/ladder/CLAUDE.md` first.
