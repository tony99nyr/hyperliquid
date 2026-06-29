# Cockpit LIVE Test Plan — run one feature at a time

**You execute each step in the cockpit; I verify after each** (HL open-orders / fills / DB
row / analysis-log) and say PASS/FAIL before you move on. Production is **LIVE — these are
REAL orders.**

## ⚠ Safety rails (read once)
- **Use the SMALLEST size** on every step. The **stop / take-profit / OCO bracket / stop-entry**
  signing paths have **never hit a real exchange** — their first live use is here. A wrong
  `tpsl` direction = an unprotective stop, so prove each one with a few dollars, not a real trade.
- **One step at a time.** Do it → tell me → I verify → next. Don't batch.
- Keep an eye on the position panel; **cancel/close** anything a step leaves resting that you
  don't want.

---

## Phase 1 — Manual trading (LIVE NOW)
*Open a tiny position first; most steps act on it.*

| # | Feature | Do (UI) | Expect | I verify |
|---|---|---|---|---|
| 1.1 | **Open (market)** | New Position → ETH → **LONG** → Risk **$5** → Approve LIVE (type `buy eth`) | position opens, shows in Open Positions | fill + position row, real HL position |
| 1.2 | **Resting stop** ⚠1st live trigger | Insights → Stop → place below entry, tiny | a stop rests on HL | HL open-orders shows the reduce-only stop on the loss side |
| 1.3 | Cancel stop | Insights → Stop → Cancel | stop gone | HL open-orders clear |
| 1.4 | **Take-profit** ⚠1st live tp | Insights → Take-profit @2R | a TP rests (profit side) | HL open-orders shows the TP |
| 1.5 | **OCO bracket** ⚠1st live positionTpsl | Insights → Protective bracket → Place both (OCO) | stop **and** TP rest, mutually-cancelling | both legs rest; closing one auto-cancels the other |
| 1.6 | **Add-to-position** | Insights → Add → tiny add → Approve | size grows, avg entry blends | position sz increases |
| 1.7 | **Add-margin** | Insights → Add margin → $5 | liq moves AWAY, effLev drops | real liq + effLeverage shift |
| 1.8 | **Adjust leverage** | Insights → Adjust leverage → change | over-margined: liq unchanged on a raise | leverage setting vs effLev |
| 1.9 | **Close (reduce-only)** | Open Positions → Close (or Safe-Exit) | flat | position flat on HL |
| 1.10 | **Stop-entry (breakout)** ⚠1st live reduceOnly:false trigger | New Position → **Trigger (rest on break)** → ETH LONG, trigger just ABOVE mark, Risk $5 → Approve LIVE | a resting entry trigger | HL open-orders shows the non-reduce-only trigger |
| 1.11 | Cancel the stop-entry | cancel it (don't let it fire unplanned) | gone | HL open-orders clear |

## Phase 2 — Ladder lifecycle (LIVE arm — moves NO money)
| # | Feature | Do (UI) | Expect | I verify |
|---|---|---|---|---|
| 2.1 | **Preview** | Ladders → New Ladder → fill a rung | risk preview (worst-case, liq, caps) | — (client preview) |
| 2.2 | **Validation gate** | set Leverage 60 | ⚠ "exceeds ETH max" + Arm disabled | — |
| 2.3 | **Pyramiding gate** | add rung: bigger size / looser stop | ⚠ "adds must DECREASE" / "stop must TIGHTEN" + Arm disabled | — |
| 2.4 | **Arm PAPER** | clean rung → Create & Arm (paper) | row → **ARMED · PAPER** | DB: status=armed, precondition_hash, rung pending + cloid |
| 2.5 | **Disarm** | Disarm button | → **disarmed** | DB: status=disarmed, reason |
| 2.6 | **Arm LIVE** | mode **LIVE** → Create draft → type `arm <id8>` → Arm LIVE | row → **ARMED · LIVE** | DB: mode=live, status=armed |
| 2.7 | Disarm the live one | Disarm | disarmed | DB |

## Phase 3 — Autonomous firing (GATED — I build + enable; you accept the risk)
**Not runnable yet.** Requires me to **(a) build the ladder-watch cron** (the autonomous trigger)
and **(b) set `LADDER_AUTOFIRE_ENABLED=true` + `LADDER_CRON_SECRET`** on Vercel. This is
**autonomous REAL money with NO testnet rehearsal** of the fire path — the highest-risk step in
the system. Recommended safety rail for the FIRST live fire:
- one **open** rung, **maxLoss ≈ $5**, trigger **just beyond** the mark so it fires soon,
- low cron frequency, watch it fire **once**, verify, then **disarm**.

| # | Step | Expect | I verify |
|---|---|---|---|
| 3.1 | Arm a tiny LIVE ladder (1 open rung, maxLoss $5) | ARMED · LIVE | DB |
| 3.2 | Watcher fires when a completed candle crosses the trigger | opens a tiny position + **brackets it atomically** | ladder_fires=filled, rung=fired, position open, stop rests |
| 3.3 | **Kill-switch**: flip `LADDER_AUTOFIRE_ENABLED` off | no further fires | fire route 403 |
| 3.4 | **Idempotency**: the fired rung does not re-fire | rung stays fired, no 2nd fill | dedupe_key claim |

---

### How we run it
Start at **1.1**. After each step, tell me what you saw (or paste a screenshot) and I'll verify
against HL / the DB and confirm PASS before the next. When Phases 1–2 are green and you're ready
for autonomous, say so and I'll build the watcher + we enable Phase 3 with the safety rail.
