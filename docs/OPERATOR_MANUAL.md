# Operator Manual — what runs where, and what YOU run

The one-page answer to "which box runs what": four runtimes, each with a distinct job.
Live/paper status: see the banner in the root [CLAUDE.md](../CLAUDE.md).
Design docs: [ARMED_LADDER_ARCHITECTURE.md](./ARMED_LADDER_ARCHITECTURE.md) ·
[LADDER_OPERATOR_RUNBOOK.md](./LADDER_OPERATOR_RUNBOOK.md) (switches, watcher, env) ·
[LADDER_DESK_PLAYBOOK.md](./LADDER_DESK_PLAYBOOK.md) · [LIVE_AUTO_EXIT.md](./LIVE_AUTO_EXIT.md).

```
DESKTOP / office box (you + Claude)   NAS (always-on, no keys)         CLOUD
───────────────────────────────────   ────────────────────────         ─────
pnpm scout:watch (systemd --user;     pnpm trader-watch (daemon)       Vercel prod: the app +
  embeds the scout consumer and       crontab: nas-watch.sh every        EXECUTORS (agent key lives
  pokes the prod crons, 10 min)         5 min (health, rubric, vault,    ONLY here; all real orders)
ad-hoc skills (pnpm skill:*)            scout lanes, then pokes          cron-job.org → ladder-watch ~2min
weekly desk retro                       auto-exit + reconcile)           healthchecks.io → dead-man alert
authoring/reviewing ladders                                              Supabase → shared DB/realtime
dev / validate / deploy
```

**The rule that explains everything:** the HL agent key exists ONLY in Vercel prod env.
Desktop and NAS can *ask* (poke an endpoint, write a row); only Vercel can *sign*. A stolen
NAS or desktop cannot move money.

---

## 1. Cloud — runs itself (verify occasionally, touch never)

| Thing | Job | If it dies |
|---|---|---|
| **Vercel prod** (`hyperliquid-rouge.vercel.app`) | The cockpit UI + every executor: ladder fire path, auto-exit executor, reconcile. Holds `HL_AGENT_PRIVATE_KEY` and the ladder switches (see the runbook, "The three switches"). | Nothing fires; resting HL stops still protect open positions. |
| **cron-job.org** | Pokes the ladder watcher every ~2 min. Details: runbook, "The watcher". | Ladders stop firing → **healthchecks.io pages you** (~13 min). |
| **healthchecks.io** | Dead-man's-switch on the ladder-watch pings. | You lose the dead-watcher page; check cron-job.org history manually. |
| **Supabase** | The shared DB + realtime the cockpit renders from. | Cockpit goes stale; HL-side stops unaffected. |

**Cron heartbeats.** The auto-exit and reconcile routes write `scout_heartbeat` rows
(`source` = `auto-exit-cron` and `reconcile`). The ladder-watch tick pages Discord when a
row is older than 30 min (re-page at most every 6h). `desk-review` also flags them STALE.
The reconcile route also writes `reconcile-ok`, but only on a run that healed: the
reconcile and the fill backfill both completed on a fresh HL read. The tick pages
RECONCILE DEGRADED when `reconcile` is fresh but its last run came 30+ min after the last
`reconcile-ok`, so one skipped run does not page. The watchdog seeds an absent
`reconcile-ok` row, and the first degraded run after an outage of 30+ min moves it up to
now, so the outage does not count as degraded. Re-pages share the 6h cooldown.
The Scout tab shows only the scout rows (`scout-watch`, `scout-cycle`).

**Monthly spot-check:** healthchecks.io shows green · cron-job.org history shows 200s ·
`vercel logs hyperliquid-rouge.vercel.app | grep ladder-watch` shows 200 not 401 · the
`reconcile` and `auto-exit-cron` heartbeat rows are fresh.

## 2. NAS — always-on plumbing (start once, survives reboots)

The NAS is a *scheduler + feed box*. It holds a poke-only bearer (`AUTO_EXIT_CRON_SECRET`,
in the env or the repo file `.auto-exit-secret`), never admin or signing keys. NAS loops
launch Node 24 via `ops/node-env.sh` (see `services/trader-watch/README.md`).

**Crontab (already installed; the reference):**
```cron
*/5 * * * * /volume1/home/admin/hyperliquid/scripts/nas-watch.sh >> /volume1/home/admin/hyperliquid/logs/nas-watch.log 2>&1
```
One `nas-watch.sh` tick runs these steps (see the script header):
1. `pnpm watch --once`: health/P&L snapshots + alerts (incl. the time-stop advisory).
2. `pnpm rubric --once`: opportunity scan + position reviews + `market_snapshots`.
3. `pnpm vault-watch --once`: vault NAV snapshots for the scout lanes.
4. `pnpm scout:lanes`: per-lane scorecard snapshot for the Scout tab.
5. `pnpm cron:nas`: pokes `/api/cron/reconcile-positions` with the bearer, then pokes
   `/api/cron/auto-exit` unless the reconcile ran with no skip and no live position is open.
   Then it stamps the auto-exit heartbeat itself, except on the first tick of each hour,
   which pokes anyway so a broken route still pages. On a failed poke it marks both
   heartbeats `nas-poke-failed`, so `scout:watch` pokes instead. Vercel Hobby caps
   Active CPU at 4 hours a month (hit 2026-11-22).

- **auto-exit**: the Layer-1 risk-exit detector. LIVE in production; the kill-switch is
  `AUTO_EXIT_ENABLED`. See [LIVE_AUTO_EXIT.md](./LIVE_AUTO_EXIT.md).
- **reconcile-positions** — keeps cockpit positions in lock-step with the REAL HL account
  (manual closes in the HL app, liquidations, partials), and backfills exchange-side
  fills into the `fills` ledger (dedupe by `hl_order_id`, 0036). Never trades.

**Two pokers.** `scout:watch` on the office box ALSO pokes both routes every 10 min with
`AUTO_EXIT_CRON_SECRET` from its `.env.local`. Either poker alone keeps the routes alive.

**Long-lived daemon:**

| Command | Job | Why you care |
|---|---|---|
| `pnpm trader-watch` | Polls top-rated leaders' HL positions → writes `leader_positions` / `leader_actions`. | **The leader guard depends on this feed.** If it's down, a `leader_address`-tagged ladder can't auto-disarm on a leader exit (the guard fails safe: it never disarms blind — you just lose the protection). |

**After a NAS reboot:** confirm crontab is live (`crontab -l`) and the daemon is up
(`pgrep -f trader-watch`).

## 3. Desktop / office box: where YOU (and Claude) work

**Supervised daemon:** `pnpm scout:watch` runs here under `systemd --user` (see
`services/scout-watch/README.md`). It writes triggers to Supabase `scout_triggers`, runs
the scout consumer (`scripts/scout-headless.sh`) EMBEDDED every
`SCOUT_CONSUMER_INTERVAL_MIN` (default 30), and pokes the prod crons. **Do not add a
separate `scout-headless.sh` cron:** two consumers can both open on the same directive.
A cron is only for a box that runs the consumer without the daemon. Consumer liveness is
the `scout_heartbeat` row `source='scout-cycle'`. The office box runs scout-watch only;
the other loops are NAS-owned.

**Timers:** `desk-retro-reminder.timer` sends a Discord ping on Mondays at 12:57 local
that the weekly retro is due (`ops/systemd/desk-retro-reminder.service` has the install
steps). Per-event straddle prep timers (`<event>-prep.timer`) are installed per event.

**Ad-hoc skills (run in a Claude session or a terminal).** The full roster is the Skills
section of the root [CLAUDE.md](../CLAUDE.md). The commands you run most:

| Command | When |
|---|---|
| `pnpm skill:analyze-market --coin X` | Before any thesis — regime/divergence read. |
| `pnpm skill:analyze-traders --addresses 0x…` | Before copying any wallet (INSUFFICIENT_HISTORY gate). |
| `pnpm skill:review-ladder --equity <usd>` | **Before every arm** + any time you want the 0/10 scorecard on armed/draft ladders. |
| `pnpm skill:ladder-expectancy` | After any ladder closes (the weekly run is part of `desk-retro`). |
| `pnpm rubric` | Refresh `rubric_scores` (feeds the review-ladder thesis pillar). |
| `pnpm skill:assess-health / advise-exit / open-position / run-session` | Position management lane (all confirm-gated). |
| `pnpm skill:agent-action` | Scoped live action from the agent's machine: tighten a stop, close reduce-only or place a take-profit, after the operator's yes (ADR-0009). Needs `AGENT_ACTIONS_ENABLED` and `AGENT_ACTION_TOKEN` in production. |
| `pnpm perf:report --since last-retro --md` | Lane performance report (the Lanes tab shows the same data). |
| `pnpm perf:marker propose --kind … --title … --write` | Propose a change marker. **Only a marker you confirm splits lane statistics:** confirm it in the Lanes tab change log (admin PIN). |
| `pnpm env:pull` | Refresh `.env.local` from Vercel (after env changes). |

**Dev loop:** see Build & Validation in the root [CLAUDE.md](../CLAUDE.md). Deploy = push
to `main` (Vercel auto-deploys).

**CI does not gate deploys yet.** GitHub Actions runs `pnpm validate` on every push and
PR, but Vercel deploys on push whatever the result. To gate, configure Vercel's
**Ignored Build Step** to skip the build unless the `Validate` check passed, or make
`Validate / validate` a required check and deploy only from a protected `main`.

**Remember (dev gotchas):** local `.env.local` has NO signing key, NO ladder flags and no
`TRADING_MODE` (so local runs resolve to paper). You can author/review ladders from the
desktop, but arming/firing is prod-only. `localhost:3000` is iamrossi.com, not this app.

## 4. The rituals (the part that makes money)

| Cadence | Do |
|---|---|
| **Before any new ladder** | `analyze-market` → (if copy) `analyze-traders` → author draft (playbook §2) → `review-ladder` until RISK ≥ ~7, no blockers → arm in the cockpit (typed phrase). Tag copy trades with `leader_address`. |
| **Daily-ish (2 min)** | Cockpit glance: armed ladders' distance-to-trigger, open positions' health, any Discord alerts (leader-exit disarm / expiry page / time-stop / stale heartbeat). |
| **Weekly (Mondays)** | Run the `desk-retro` skill (`.claude/skills/desk-retro/SKILL.md`). It bundles the scout review, shadow replay, ladder expectancy, the discard vet and `perf:*`. Confirm healthchecks green. |
| **Monthly** | Spot-check the cloud row (§1). Rotate secrets if due (see below). |

**Secret rotation.**
- `LADDER_CRON_SECRET`: update the cron-job.org request header to match.
- `AUTO_EXIT_CRON_SECRET` (bearer for auto-exit + reconcile): update BOTH pokers, the NAS
  `.auto-exit-secret` file AND `.env.local` on the scout box, then restart `scout:watch`.
  A stale NAS secret once left both routes dead for six weeks.
- After any rotation, check that the `reconcile` and `auto-exit-cron` heartbeats refresh.

**Read-only viewer access.** A second PIN, `VIEWER_PIN`, lets a person see the whole
cockpit (positions, ladders, performance, lanes, scout, traders) and change nothing.
A viewer session gets a "READ-ONLY" banner and no action controls. The server is the real
control: every mutating route calls `verifyAdminAuth`, which refuses a viewer session.
`tests/lib/api/viewer-deny-by-default.test.ts` fails if a non-GET route accepts a viewer.
A viewer may call only 13 cockpit read routes and the two market-data proxies
(`/api/hl/candles`, `/api/hl/regime`), all GET.
A viewer does not see the approval popup, so a viewer does not see pending previews. A
viewer also gets no favourite, follow, copy, stage, mirror or vet controls in the trader
views.

To give access:
1. Make a new PIN. Use at least 12 random characters. Do not reuse `ADMIN_PIN` or
   `ADMIN_SECRET`: the app ignores a `VIEWER_PIN` that equals either of them.
2. In the Vercel dashboard, open the project, then Settings → Environment Variables. Add
   `VIEWER_PIN` for Production only. Mark it Sensitive.
3. Redeploy production. Vercel applies a new variable only to a new deployment.
4. Send the PIN to the viewer through a private channel, for example a password manager
   share or Signal. Do not post it in a group chat or an email thread.
5. The viewer opens `/cockpit` and types the PIN at the PIN gate.

To revoke access, remove `VIEWER_PIN` or change its value, then redeploy. The viewer
session token carries a hash of the PIN, so the change ends every open viewer session at
once. A rotation of `ADMIN_SECRET` also ends every session, the admin session included.
The login route shares the per-IP rate limit with the admin login.

## 5. Emergency card

This is the canonical emergency card for the whole desk.

| Want | Do |
|---|---|
| **Stop ALL autonomous firing NOW** | Vercel env → `LADDER_AUTOFIRE_ENABLED=false` (fire path re-checks every fire). Armed ladders stay armed but nothing fires. |
| Stop ONE ladder | Cockpit → Ladders → row → **Disarm**. Disarm stops future fires; it does NOT cancel resting orders (stops stay on the position). |
| Stop the auto-exit | Vercel env → `AUTO_EXIT_ENABLED=false`. |
| Flatten a position | Cockpit **Safe-Exit** button (always armed with a fresh plan), or the HL app directly — reconcile will resync the cockpit. |
| Watcher dead? | healthchecks.io page → check cron-job.org history → check Vercel logs. |
| Something fired that shouldn't | Read `ladder_fires` + the detail modal; every fire re-validated the full guard stack server-side — the audit trail is in the DB. |
