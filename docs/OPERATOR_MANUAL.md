# Operator Manual — what runs where, and what YOU run

The one-page answer to "which box runs what": four runtimes, each with a distinct job.
Design docs: [ARMED_LADDER_ARCHITECTURE.md](./ARMED_LADDER_ARCHITECTURE.md) ·
[LADDER_OPERATOR_RUNBOOK.md](./LADDER_OPERATOR_RUNBOOK.md) ·
[LADDER_DESK_PLAYBOOK.md](./LADDER_DESK_PLAYBOOK.md) · [LIVE_AUTO_EXIT.md](./LIVE_AUTO_EXIT.md).

```
DESKTOP (you + Claude)          NAS (always-on, no keys)        CLOUD
──────────────────────          ────────────────────────        ─────
ad-hoc skills (pnpm skill:*)    pnpm trader-watch (daemon)      Vercel prod: the app +
weekly rituals                  pnpm scout:watch (daemon)         EXECUTORS (agent key lives
authoring/reviewing ladders     pnpm watch (daemon, optional)     ONLY here — all real orders)
dev / validate / deploy         crontab → curls Vercel:         cron-job.org → ladder-watch ~2min
                                  auto-exit         (5 min)     healthchecks.io → dead-man alert
                                  reconcile-positions (5 min)   Supabase → shared DB/realtime
```

**The rule that explains everything:** the HL agent key exists ONLY in Vercel prod env.
Desktop and NAS can *ask* (poke an endpoint, write a row); only Vercel can *sign*. A stolen
NAS or desktop cannot move money.

---

## 1. Cloud — runs itself (verify occasionally, touch never)

| Thing | Job | If it dies |
|---|---|---|
| **Vercel prod** (`hyperliquid-rouge.vercel.app`) | The cockpit UI + every executor: ladder fire path, auto-exit executor, reconcile. Holds `HL_AGENT_PRIVATE_KEY`, `LADDER_LIVE_ENABLED`, `LADDER_AUTOFIRE_ENABLED`. | Nothing fires; resting HL stops still protect open positions. |
| **cron-job.org** | Pokes `GET /api/cron/ladder-watch` every ~2 min (`Authorization: Bearer $LADDER_CRON_SECRET`). Each tick: evaluate armed rungs → fire → leader guard → expiry alerts → healthcheck ping. | Ladders stop firing → **healthchecks.io pages you** (~13 min). |
| **healthchecks.io** | Dead-man's-switch on the ladder-watch pings (Period 5 min / Grace ~13 min). | You lose the dead-watcher page — check cron-job.org history manually. |
| **Supabase** | The shared DB + realtime the cockpit renders from. | Cockpit goes stale; HL-side stops unaffected. |

**Monthly spot-check:** healthchecks.io shows green · cron-job.org history shows 200s ·
`vercel logs hyperliquid-rouge.vercel.app | grep ladder-watch` shows 200 not 401.

## 2. NAS — always-on plumbing (start once, survives reboots)

The NAS is a *scheduler + feed box*. It holds `CRON_SECRET` / `LADDER_CRON_SECRET` bearer
tokens (poke-only), never admin or signing keys.

**Crontab (already installed; the reference):**
```cron
*/5 * * * *  curl -s -H "Authorization: Bearer $CRON_SECRET" https://hyperliquid-rouge.vercel.app/api/cron/auto-exit
*/5 * * * *  curl -s -H "Authorization: Bearer $CRON_SECRET" https://hyperliquid-rouge.vercel.app/api/cron/reconcile-positions
# ^ reconcile also BACKFILLS exchange-side fills (resting stop/bracket fills, manual
#   HL-app closes) into the `fills` ledger — dedupe by hl_order_id (unique index,
#   0036), attributed to the holding live session. Discord 🚨 on any shortfall.
```
- **auto-exit** — the Layer-1 risk-exit detector (no-ops while `AUTO_EXIT_ENABLED=false`).
- **reconcile-positions** — keeps cockpit positions in lock-step with the REAL HL account
  (manual closes in the HL app, liquidations, partials). Never trades.

**Long-lived daemons (run under a supervisor / `nohup` / systemd so they restart):**

| Command | Job | Why you care |
|---|---|---|
| `pnpm trader-watch` | Polls top-rated leaders' HL positions → writes `leader_positions` / `leader_actions`. | **The leader guard depends on this feed.** If it's down, a `leader_address`-tagged ladder can't auto-disarm on a leader exit (the guard fails safe: it never disarms blind — you just lose the protection). |
| `pnpm scout:watch` | FREE deterministic trigger daemon for the paper scout — writes triggers to the **Supabase `scout_triggers` table** (any-box visibility, consumed-cursor; JSONL fallback only when Supabase is unreachable); never trades. | Producer half. The **consumer** is now schedulable: add a crontab line for `scripts/scout-headless.sh` (~every 30 min, any box) — snapshot → headless Sonnet decision → strict-JSON paper trade. Consumer liveness = the `scout_heartbeat` row `source='scout-cycle'` (stale row = dead consumer, page-able). |
| `pnpm watch` | Crash-safe position watcher: health/pnl snapshots + alerts (incl. the **time-stop** advisory) for open positions. Also auto-spawned on fill wherever a fill executes. | Cockpit health panels go stale; alerts (drawdown / big-move / time-stop) stop. Resting stops unaffected. |
| `pnpm vault-watch` | Vault-equity snapshots for the scout lanes. | Scout lane scorecards go stale. |

```cron
*/30 * * * *  cd /path/to/hyperliquid && ./scripts/scout-headless.sh >> ~/.hl-scout-headless.log 2>&1
```

**After a NAS reboot:** confirm crontab is live (`crontab -l`) and the daemons are up
(`pgrep -f trader-watch`, etc.).

## 3. Desktop — where YOU (and Claude) work

Nothing on the desktop needs to stay running. Two kinds of work:

**Ad-hoc skills (run in a Claude session or a terminal):**

| Command | When |
|---|---|
| `pnpm skill:analyze-market --coin X` | Before any thesis — regime/divergence read. |
| `pnpm skill:analyze-traders --addresses 0x…` | Before copying any wallet (INSUFFICIENT_HISTORY gate). |
| `pnpm skill:review-ladder --equity <usd>` | **Before every arm** + any time you want the 0/10 scorecard on armed/draft ladders. |
| `pnpm skill:ladder-expectancy` | **Weekly + after any ladder closes** — resolve outcomes, get KILL/HOLD/SIZE-UP verdicts. |
| `pnpm rubric` | Refresh `rubric_scores` (feeds the review-ladder thesis pillar). |
| `pnpm skill:assess-health / advise-exit / open-position / run-session` | Position management lane (all confirm-gated). |
| `pnpm scout:review` | Weekly scout playbook curation (Opus-tier). Has NEVER run as of 2026-07-02 — the playbook is still the empty seed. |
| `pnpm env:pull` | Refresh `.env.local` from Vercel (after env changes). |

**Dev loop:** `pnpm validate` before every commit; `pnpm smoke` before pushing UI changes;
deploy = push to `main` (Vercel auto-deploys).

**Remember (dev gotchas):** local `.env.local` has NO signing key and NO ladder flags — you
can author/review ladders from the desktop but arming/firing is prod-only. `localhost:3000`
is iamrossi.com, not this app.

## 4. The rituals (the part that makes money)

| Cadence | Do |
|---|---|
| **Before any new ladder** | `analyze-market` → (if copy) `analyze-traders` → author draft (playbook §2) → `review-ladder` until RISK ≥ ~7, no blockers → arm in the cockpit (typed phrase). Tag copy trades with `leader_address`. |
| **Daily-ish (2 min)** | Cockpit glance: armed ladders' distance-to-trigger, open positions' health, any Discord alerts (leader-exit disarm / expiry page / time-stop). |
| **Weekly (15 min)** | `pnpm skill:ladder-expectancy` → act on verdicts (a KILL is a standing stop-trading-it; a SIZE-UP earns ONE tier step). `pnpm scout:review` for the paper lane. Confirm healthchecks green. |
| **Monthly** | Spot-check the cloud row (§1). Rotate secrets if due (update cron-job.org header when rotating `LADDER_CRON_SECRET`). |

## 5. Emergency card

| Want | Do |
|---|---|
| **Stop ALL autonomous firing NOW** | Vercel env → `LADDER_AUTOFIRE_ENABLED=false` (fire path re-checks every fire). |
| Stop ONE ladder | Cockpit → Ladders → row → **Disarm**. |
| Flatten a position | Cockpit **Safe-Exit** button (always armed with a fresh plan), or the HL app directly — reconcile will resync the cockpit. |
| Watcher dead? | healthchecks.io page → check cron-job.org history → check Vercel logs. |
| Something fired that shouldn't | Read `ladder_fires` + the detail modal; every fire re-validated the full guard stack server-side — the audit trail is in the DB. |
