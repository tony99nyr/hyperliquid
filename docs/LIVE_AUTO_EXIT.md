# Live Auto-Exit (Layer 1) — design + safety contract

An **autonomous, exit-only safety net** for live positions left unattended: it can
**close** a position (reduce-only) when a hard risk condition is met, so you can
leave trades on overnight without watching them. This is a **deliberate, scoped
exception** to the cockpit's founding no-auto-fire rule.

> **Status:** BUILT, shipped **DISABLED**. It does nothing until `AUTO_EXIT_ENABLED=true`
> AND a critical review signs off (see "Enabling it"). The decision logic, execution
> path, lock, routes, and cron are all in place and unit-tested.

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
 NAS watch detector (primary, frequent)            Vercel (has the agent key)
 ──────────────────────────────────────            ─────────────────────────────────
 finds open positions, POSTs candidates    →   POST /api/cockpit/risk-exit (cron token)
 (sessionId, coin) to the endpoint                  │
                                                    ▼
 Vercel Cron /api/cron/auto-exit (backup)  →   performRiskExit(sessionId, coin)  ← the ONE site
 lists open positions, calls the same site          ├─ RE-VERIFY from fresh data (mark + clearinghouse + health)
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
- **Dual scheduler** (NAS primary + Vercel cron backup) so a NAS outage doesn't leave
  positions unguarded.

## Safety mechanisms

- **Kill-switch:** `AUTO_EXIT_ENABLED` (default OFF). Both routes refuse and the cron
  no-ops unless explicitly `true`.
- **Exit-only, structurally:** intent built only by `buildMarketReduceOnlyClose` from
  the live position; caller supplies only `(sessionId, coin)`.
- **Re-verify before firing:** the server recomputes mark + clearinghouse + health and
  re-runs the decision; a stale/spoofed candidate can't fire a close on its own.
- **Dedicated auth:** the detector/cron present `AUTO_EXIT_CRON_SECRET` (a Bearer
  token), **not** the admin secret — the NAS never holds the admin credential.
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
  buffer for *gradual* drift toward liq, not a guarantee. The NAS detector (more frequent)
  tightens this but the same caveat holds.
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
   (`auto-exit-scan.ts`) + `/api/cron/auto-exit` + `vercel.json` cron.
6. ⏳ **Critical review, then enable.**

## Config knobs

| Knob | Where | Default | Meaning |
|---|---|---|---|
| `AUTO_EXIT_ENABLED` | env | `false` | master kill-switch |
| `AUTO_EXIT_CRON_SECRET` | env | — | Bearer token for the detector/cron |
| `CRON_SECRET` | env (Vercel) | — | set EQUAL to `AUTO_EXIT_CRON_SECRET` so Vercel's cron header matches |
| `HL_ACCOUNT_ADDRESS` | env | — | master account (public) for clearinghouse liq/margin reads |
| `liqProximityPct` | manifest | `0.03` | close if liq within this of mark (needs clearinghouse) |
| `maxLossUsd` | manifest | `40` | close if uPnL ≤ −this |
| `maxLossPctOfMargin` | manifest | `0.6` | close if loss ≥ this fraction of margin (needs clearinghouse) |
| `minHealthScore` | manifest | `15` | close if health below this |
| `hardExitAlerts` | manifest | `["regime-flip-8h"]` | alerts that force an exit |
| `cooldownMs` | manifest | `120000` | min ms between exits per (session, coin) |

## Enabling it (do NOT skip)

1. Critical-review the whole feature (exit-only proof, lock race, auth).
2. Apply migration `0008_auto_exit_locks.sql` to Supabase.
3. Set `HL_ACCOUNT_ADDRESS` (for liq/margin triggers), `AUTO_EXIT_CRON_SECRET`, and
   `CRON_SECRET` (= the same value) in Vercel.
4. Rehearse on **testnet** (`HL_NETWORK=testnet`) or in **paper** first — auto-exit is
   mode-agnostic (it closes whatever the active mode holds), so a paper rehearsal
   exercises the full path safely.
5. Flip `AUTO_EXIT_ENABLED=true`. Watch the analysis log for the first real fire.
