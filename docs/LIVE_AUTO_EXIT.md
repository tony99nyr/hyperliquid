# Live Auto-Exit (Layer 1) — design + safety contract

An **autonomous, exit-only safety net** for live positions left unattended: it can
**close** a position (reduce-only) when a hard risk condition is met, so you can
leave trades on overnight without watching them. This is a **deliberate, scoped
exception** to the cockpit's founding no-auto-fire rule. This file is the canonical home
for auto-exit status, coverage and the enable/disable steps.

> **Status:** LIVE in production since 2026-09-05 (operator decision), as the
> catastrophe backstop. The kill-switch is `AUTO_EXIT_ENABLED` in Vercel env (set it
> `false` to stop it). It scans LIVE sessions only. The enable checklist below is kept
> as the record of how it went live.

---

## The one hard invariant: EXIT-ONLY

The auto-exit can **only reduce/close** an existing position. It can **never open,
add, or flip.** This is enforced *structurally*, not by convention: the reduce-only
intent is built **only** by `buildMarketReduceOnlyClose(position, …)` (the same pure
fn the Safe-Exit button uses), which derives the opposite side from the *live*
position and hard-codes `reduceOnly: true`. The caller (NAS/cron) supplies only a
`(sessionId, coin)` candidate — never a side, size, or "please open." The worst case
is "flattened out of the market."

## Triggers (close when ANY fires)

Per open position, re-verified server-side each cycle (pure `shouldAutoExit`):

1. **Liquidation proximity** — liq price within `liqProximityPct` of the mark, **on
   the loss side** (above mark for a short, below for a long; a bogus liq on the
   profitable side never closes a winner). The key leveraged-overnight guard.
2. **Loss threshold** — uPnL ≤ `−maxLossUsd`, **or** loss ≥ `maxLossPctOfMargin` of
   margin, **or** margin fully eroded while losing. A stop you don't babysit.
3. **Unhealthy / too risky** — health score < `minHealthScore`, **or** a hard adverse
   alert (`hardExitAlerts`, e.g. `regime-flip-8h`). The "market turned, preserve
   capital" call. Uses the **per-coin** health from #14.

**Fail-safe data handling:** a non-finite/≤0 critical input (mark/margin/P&L) never
silently disables every trigger via NaN comparisons — the affected trigger is skipped
and `dataDegraded` is flagged, which raises a danger alert so the operator re-checks
the feed rather than trusting a false "all clear."

**Threshold applicability:** `liquidationPx` + margin come only from HL's
`clearinghouseState` (live + `HL_ACCOUNT_ADDRESS`). When that's unavailable, the liq +
margin-%-of-margin triggers are **disabled** (not "degraded") and the always-computable
loss-USD + health triggers carry the net. uPnL is computed from the live position + mark
when clearinghouse uPnL is absent.

All thresholds live in a versioned manifest (`data/auto-exit/`), tunable without code.

## Architecture — detect anywhere, execute in ONE place

```
 Two pokers (NAS + scout box)                      Vercel (has the agent key)
 ──────────────────────────────────────            ─────────────────────────────────
 NAS nas-watch.sh (5 min) and scout:watch   →   GET /api/cron/auto-exit (Bearer cron secret)
   (10 min), both just poke                       │  lists open LIVE-session positions, then per position:
   the executor; holds NO trading key             ▼
 (optional manual: POST /api/cockpit/       →   performRiskExit(sessionId, coin)  ← the ONE site
   risk-exit for an admin-triggered exit)          ├─ RE-VERIFY from fresh data (mark + clearinghouse + health)
                                                    ├─ run PURE shouldAutoExit
                                                    ├─ acquire per-(session,coin) LOCK (anti-double-close)
                                                    ├─ reduce-only CLOSE via executeIntent
                                                    └─ log + loud alert (success / partial / failure)
```

- The **agent key (`HL_AGENT_PRIVATE_KEY`) stays only on Vercel.** Detectors never
  hold it; they only POST candidates.
- **`performRiskExit` is the single exit-only execution site.** Both the HTTP route and
  the cron call it; it re-verifies the condition itself (never trusts the caller's
  "please exit") before signing — defense in depth.
- **`src/lib/auto-exit/**` is execution-free** (detection + config + lock only),
  enforced by a static no-execute test, so the decision + firing live in exactly one
  auditable place (`src/lib/trading/risk-exit-service.ts`).
- **Two pokers, no Vercel cron** (no Vercel Pro needed). The NAS `nas-watch.sh` tick
  pokes the endpoint every 5 min, and `scout:watch` on the office box pokes it every
  10 min. The executor + agent key stay on Vercel. Only when BOTH pokers are down do the
  checks pause (the manual Safe-Exit always remains). Each run writes the
  `scout_heartbeat` row `source='auto-exit-cron'`; the ladder-watch tick pages Discord
  when it is older than 30 min.

## Safety mechanisms

- **Kill-switch:** `AUTO_EXIT_ENABLED` (code default OFF; ON in production). Both routes
  refuse and the cron no-ops unless explicitly `true`.
- **Exit-only, structurally:** intent built only by `buildMarketReduceOnlyClose` from
  the live position; caller supplies only `(sessionId, coin)`.
- **Re-verify before firing:** the server recomputes mark + clearinghouse + health and
  re-runs the decision; a stale/spoofed candidate can't fire a close on its own.
- **Dedicated auth:** the pokers present `AUTO_EXIT_CRON_SECRET` (a Bearer token; the
  server falls back to `CRON_SECRET` only when it is unset), **not** the admin secret.
  The NAS and the scout box never hold the admin credential.
  Constant-time compared. Manual admin triggers still work via admin auth + same-origin.
- **Idempotency / no double-close:** an atomic per-(session,coin) lock
  (`auto_exit_locks`, partial unique index → exactly one active lock). A NAS+cron race
  resolves to a single winner; the lock window doubles as the cooldown. A failed/partial
  close releases the lock immediately so the next cycle retries; a clean full close keeps
  it until expiry (cooldown).
- **Loud failure alerts:** a failed, no-fill, or partial close writes a **danger**-
  severity analysis-log entry ("position STILL OPEN") so a silent failure can't hide.
- **Notifications:** every fire logs the trigger reason + the fill.
- **Human override:** Safe-Exit / manual close always available; auto-exit is a floor.

## Honest limitations

- **It reduces, it does not eliminate, liquidation risk.** A ~5-min cron + an HTTP hop +
  an IOC book-walk cannot beat a fast cascade liquidation; the liq-proximity trigger is a
  buffer for *gradual* drift toward liq, not a guarantee.
- **Layer 1 is deterministic thresholds only** — no LLM-in-the-loop reasoning. The health
  engine *is* the market read. Discretionary live Claude judgment is **Layer 2** (a
  separate, larger build).
- **No sizing decisions** — it only flattens.

## Build order (status)

1. ✅ PURE `src/lib/trading/auto-exit-business-logic.ts` (`shouldAutoExit`) — unit-tested.
2. ✅ PURE `risk-inputs-business-logic.ts` (assemble inputs + resolve thresholds) + config
   manifest (`data/auto-exit/`) + env (`AUTO_EXIT_ENABLED`, `AUTO_EXIT_CRON_SECRET`,
   `HL_ACCOUNT_ADDRESS`).
3. ✅ Lock (`auto_exit_locks` migration 0008 + `auto-exit-lock-service.ts`).
4. ✅ `performRiskExit` (`risk-exit-service.ts`) — re-verify + lock + reduce-only close +
   alerts.
5. ✅ `/api/cockpit/risk-exit` (cron-token | admin auth, kill-switch) + scan
   (`auto-exit-scan.ts`) + `/api/cron/auto-exit` (poked by the NAS and by `scout:watch`;
   no Vercel cron / no Pro needed).
6. ✅ **Critical review done (2026-06-19).** 7. ✅ **Enabled in production 2026-09-05.**

## Config knobs

| Knob | Where | Default | Meaning |
|---|---|---|---|
| `AUTO_EXIT_ENABLED` | env | `false` (ON in prod) | master kill-switch |
| `AUTO_EXIT_CRON_SECRET` | env (Vercel) | none | Bearer the pokers present (auto-exit AND reconcile). Precedence: `AUTO_EXIT_CRON_SECRET ?? CRON_SECRET`. Rotating it means updating the NAS `.auto-exit-secret` file AND the scout box `.env.local`. |
| `HL_ACCOUNT_ADDRESS` | env | — | master account (public) for clearinghouse liq/margin reads |
| `liqProximityPct` | manifest (v0.2) | `0.04` | close if liq within this of mark (needs clearinghouse) |
| `maxLossUsd` | manifest (v0.2) | `30` | close if uPnL ≤ −this (**TUNE to account size**) |
| `maxLossPctOfMargin` | manifest (v0.2) | `0.5` | close if loss ≥ this fraction of margin (needs clearinghouse) |
| `minHealthScore` | manifest (v0.2) | `12` | close if health below this |
| `hardExitAlerts` | manifest (v0.2) | `[]` | alerts that force an exit (regime-flip-8h dropped in v0.2) |
| `lockTtlMs` | manifest | `120000` | active-lock window (cooldown after an unknown-outcome fire + stuck-lock reaper) |

## What you ACTUALLY get when you enable it (read before flipping it on)

Enabling is not all-or-nothing — coverage depends on deploy state. Be honest with
yourself about which of these is true:

- **Trigger cadence.** The NAS pokes every 5 min and `scout:watch` every 10 min (no
  Vercel cron). A 5-min poll + HTTP hop + IOC **cannot beat a fast liquidation
  cascade**; it catches *gradual* drift. Treat it as a slow-drift backstop, not a
  liquidation preventer.
- **Liq + margin triggers need `HL_ACCOUNT_ADDRESS` + live mode.** Without the address
  they are **silently DISABLED** and only the loss-USD + health triggers run. The cron
  response's `coverage.liqMarginTriggers` field tells you which state you're in — check it.
- **Only positions in an ACTIVE LIVE cockpit session are scanned.** Paper sessions are
  skipped (`auto-exit-scan.ts`), so a paper position is never closed and paper cannot
  rehearse it. A position opened directly on HL (outside the cockpit) or whose session
  is closed is **never guarded**.
- **Threshold sizing.** `maxLossUsd` is a flat dollar floor — it does NOT scale to
  position size. On a small account/position, tune it (or rely on `maxLossPctOfMargin`,
  which needs clearinghouse) so ordinary noise doesn't nuisance-close a fine trade.
- **Immediate.** Flipping `AUTO_EXIT_ENABLED=true` while `TRADING_MODE=live` arms
  autonomous **real** closes on the **next poke**. Don't enable and walk away.

## Enabling it (the record; completed 2026-09-05)

1. Critical-review the whole feature (exit-only proof, lock race, auth). ✅ done 2026-06-19.
2. Apply migration `0008_auto_exit_locks.sql` to Supabase. (If skipped, the lock acquire
   throws and the fire safely ABORTS — fail-safe, never a lock-free double-fire.)
3. Set `HL_ACCOUNT_ADDRESS` (else liq/margin triggers are DARK) and `AUTO_EXIT_CRON_SECRET` in Vercel.
4. Tune `data/auto-exit/` thresholds to your account size (esp. `maxLossUsd`). ✅ v0.2 is
   tuned for a small (~$150) account and already dropped `regime-flip-8h`.
5. Give both pokers the bearer: the NAS `.auto-exit-secret` file (read by `nas-watch.sh`)
   and the scout box `.env.local` (read by `scout:watch`).
6. Rehearse on **testnet** (`HL_NETWORK=testnet`) with a live-mode session (paper sessions
   are not scanned), and watch ONE real fire in the analysis log before trusting it overnight.
7. Flip `AUTO_EXIT_ENABLED=true`.
