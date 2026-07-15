# Armed Ladder — Operator Runbook

How to author, arm, monitor, and stop armed ladders, and what to expect when one fires.
For the design see [ARMED_LADDER_ARCHITECTURE.md](./ARMED_LADDER_ARCHITECTURE.md); for the
code rules see [src/lib/ladder/CLAUDE.md](../src/lib/ladder/CLAUDE.md).

## What it is, in one breath
You author a multi-rung plan (each rung = *deterministic trigger → pre-authorized order:
open / add / reduce / close, with size, leverage, stop, optional target*). You **arm** it
with a typed phrase. A watcher then **fires each rung autonomously** the moment its trigger
hits on a **completed 15m candle**, resting a native protective stop on the fill. The arm
IS the authorization — the watcher has zero discretion.

## Lifecycle
```
author (draft)  →  ARM (typed phrase, authorization)  →  watcher fires rung on 15m close
                                                          →  real fill + atomic stop
                                                          →  all rungs terminal → DONE
```
- **Author** — via Claude in conversation, or the "+ New Ladder" builder in the Ladders
  tab. A draft moves no money and arms nothing.
- **Arm** — Ladders tab → click the ladder row → review the chart + per-rung trade + the
  worst-case → type `arm <first-8-chars-of-id>` → **Arm LIVE**. Arming is an authorization
  transition only (draft → armed); it still moves no money.
- **Fire** — the watcher evaluates armed rungs each tick and fires any whose trigger a
  completed 15m candle has closed through. Only this step moves money.
- **Done** — when every rung is terminal (fired/skipped/failed/cancelled) the ladder flips
  to `done`, leaves the watcher set + the cockpit Armed panel, and the position lives on in
  Open Positions with its resting stop.

## Close the loop weekly (`ladder-expectancy`)
Run `pnpm skill:ladder-expectancy` weekly and after any ladder closes: it resolves terminal
ladders into the outcome ledger (planned slip-aware R vs HL-realized R) and verdicts each
setup type — KILL / HOLD / SIZE-UP / COLLECT — against a pre-registered bar. Also live now:
the **leader guard** (a `leader_address`-tagged ladder auto-disarms when the leader exits —
disarm-only), the **expiry-approaching page** (<12h unfired → one Discord alert), and the
watch daemon's **time-stop advisory** (open >5d without progress → review).

## Grade it before you arm (`review-ladder`)
Run `pnpm skill:review-ladder [--ladder <id>] --equity <usd>` to score any draft or open
ladder 0/10 on RISK (liq safety, loss/equity, stop integrity, pyramiding, funding, ops) and
UPSIDE (reward:risk, scale-out, convexity, thesis) pillars, with hard **blockers** called out.
With no `--ladder` it scores every armed + draft ladder and the OCO-aware book heat. Advisory
only — it never arms. Aim for RISK ≥ ~7 with no blockers; the cockpit's Arm button gates on
the same engine blockers (and now shows *why* it's disabled). See the desk method in
[LADDER_DESK_PLAYBOOK.md](./LADDER_DESK_PLAYBOOK.md).

## The three switches (independent; all ON in production)
| Env flag | Controls | Default |
|---|---|---|
| `TRADING_MODE=live` | Whether *manual* cockpit actions sign real money (global paper↔live). | — |
| `LADDER_LIVE_ENABLED` | Whether a **live**-mode ladder may be **armed**. | OFF |
| `LADDER_AUTOFIRE_ENABLED` | Whether the watcher may **autonomously fire** an armed rung. | OFF |

"Go live for manual trading" does **not** imply autonomous firing — that's the separate
`LADDER_AUTOFIRE_ENABLED` gate. To **stop all autonomous firing instantly**, flip
`LADDER_AUTOFIRE_ENABLED=false` on Vercel (the fire path re-checks it every fire). To stop
a *specific* ladder, **disarm** it (Ladders row → Disarm, or the cockpit panel → Disarm).

## The watcher
- **External scheduler** (cron-job.org, because Vercel Hobby caps crons at daily) hits
  `GET https://hyperliquid-rouge.vercel.app/api/cron/ladder-watch` every ~2 min with header
  `Authorization: Bearer $LADDER_CRON_SECRET`.
- Each tick: load armed ladders → build a completed-15m-candle snapshot per pending coin →
  evaluate (pure) → fire met rungs. Fail-closed: a stale/lagging feed or fewer than two
  candles → no fire.
- **If you rotate `LADDER_CRON_SECRET`** on Vercel, update the cron-job.org request header
  to match, or the watcher 401s and nothing fires. Verify with a longer log capture:
  `vercel logs hyperliquid-rouge.vercel.app | grep ladder-watch` — you want `200`, not `401`.
- **Dead-watcher alert:** the tick pings an external healthchecks.io dead-man's-switch
  (`LADDER_WATCH_HEALTHCHECK_URL`, /start → success/fail after cron auth). If pings stop
  (Period 5 min / Grace ~13 min), healthchecks pages you — a dead scheduler no longer
  fails silently. Belt-and-suspenders: cron-job.org's execution history still works.

## What you'll see in the UI
- **Ladders tab** — every ladder as a row (status: draft / armed / disarmed / **done = "✓
  filled"** / expired). Click a row → the detail modal.
- **Detail modal** — a 15m chart with every rung's trigger/stop/target overlaid + the live
  mark; a per-rung card (trigger, **live "needs −X% to fire"** distance, size, notional,
  leverage, stop, **risk at stop AND the 10%-slipped max loss**, target, reward, R:R);
  the aggregate worst-case; and, when armed/fired, a green completion banner.
- **Cockpit → Armed Ladders panel** — only ladders with pending rungs (primed to fire),
  with live distance-to-trigger for every coin. Clickable into the detail modal. A fired
  ladder leaves this panel (it's a position now).
- **Cockpit → Open Positions** — where a fired rung's live position + P&L show up.

## When a rung fires — what to expect (important)
A rung fires on the **completed candle close through the trigger**, so the real fill
**overshoots the trigger**. The position is then sized off that fill mark:
- **Entry, stop price, and size-in-coins differ from the previewed trigger values.**
- **Dollar risk and notional are fixed** (`notional = riskUsd / stopFrac`, mark-invariant).

Example (live, 2026-06-29): a $1,602 short trigger filled at the ~$1,594 close →
0.0627 ETH / ~$100 notional / stop $1,674 (5% above the *fill*) / **$5 risk preserved**.
This is by design; the modal states it ("fills at the 15m close (may overshoot); dollar
risk & notional are fixed").

**Verify a fire against HL** (admin-authed, server-side):
```
GET /api/cockpit/account-risk?coin=ETH   → live position (liq, eff leverage, margin)
GET /api/cockpit/stops?coin=ETH          → the resting stop (oid, triggerPx, sz)
GET /api/cockpit/ladder/<id>             → rung status = fired, ladder status
```

## Multi-rung adds (built, NOT yet live-proven — handle with care)
A ladder can scale into a winner: rung 1 `open`, rung 2+ `add`. Two guardrails are
enforced:
- **Decreasing size + tightening stop** (rejected at arm if violated) — keeps the average
  entry near the first rung; the opposite of averaging-down.
- **Add-coverage gate (runtime):** an `add` fires **only if its worst-case loss is fully
  covered by the open position's current unrealized profit.** A flat/losing position →
  the add is **skipped**, not fired. This anti-martingale rule has not yet run against the
  live exchange; treat the first multi-rung live ladder as a deliberate test.

## Troubleshooting — "my rung didn't fire"
| Symptom | Likely cause |
|---|---|
| Nothing fires, ever | `LADDER_AUTOFIRE_ENABLED` off, or the cron-job.org scheduler is down / 401ing. |
| Watcher returns `autofireOff:true` | `LADDER_AUTOFIRE_ENABLED=false`. |
| Rung skipped `precondition-drift`, ladder auto-disarmed | You closed/flipped/re-levered the underlying position after arming — the snapshot no longer matches. Re-author + re-arm. |
| Rung skipped `mode-mismatch` | The firing deployment's `TRADING_MODE` doesn't match the ladder's mode (paper box vs live box). |
| `add` skipped despite the trigger hitting | The position wasn't in enough unrealized profit to cover the add's risk (the coverage gate did its job). |
| Mark crossed intrabar but no fire | Correct — it fires only if the 15m candle **closes** through, not on an intrabar wick. |
| Arm rejected with warnings | `validateLadderForArm` failed (missing stop, leverage out of band, adds not decreasing, mixed long/short on one coin, caps breached, non-price trigger). |

## Emergency stop
1. **All autonomous firing:** `LADDER_AUTOFIRE_ENABLED=false` on Vercel (re-deploy or the
   route picks it up). Armed ladders stay armed but nothing fires.
2. **A live position:** manage it from Open Positions / the safe-exit path — it's a normal
   HL position with a resting stop, independent of ladder status.
3. **A specific ladder:** disarm it (instant; the row/panel Disarm button).

## Env: LADDER_BOOK_HEAT_MAX_FRAC

Fire-time book-heat ceiling (fraction of live equity; default 0.10). Every LIVE open/add
is skipped while the slip-aware worst case of the whole book + the firing rung exceeds
it. NaN-proof: a malformed value falls back to 0.10 (never disables the gate).

## stop_move ratchet ladders (0035)

A `stop_move` rung moves the RESTING stop to `triggerMeta.moveTo` (price or `'breakeven'`)
when its price trigger prints. Risk-reducing only; new stop is placed BEFORE the old is
canceled.

**Arm ratchet ladders only AFTER the position exists.** The arm-time precondition
snapshot records the coin's live state; a ratchet armed while the coin is FLAT will
auto-disarm with `precondition-drift` the moment the position appears (correct fail-closed
behavior — the ladder was authorized against a different world). Sequence: position fills →
create + arm the ratchet.
