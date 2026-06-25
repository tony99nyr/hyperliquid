# research-trader-worker service

The on-demand **copyability vetting** queue drainer (PR-3). Runs alongside
`trader-watch` on the **NAS** (same host so all Hyperliquid reads centralize on one
IP — the per-IP-429 avoidance the architecture relies on). It is NOT an agent and
NEVER trades.

Each loop it claims a pending `evaluation_requests` row, fetches the wallet's HL
fills + clearinghouse, computes the copyability fingerprint
(`trader-fingerprint-business-logic`), and writes a `trader_evaluations` row that the
cockpit drawer + the `review-trader` skill read (one-evaluation-two-consumers). On
startup it reclaims any request orphaned in `processing` by a crashed prior run.

Outbound-only — opens no listening port.

## Scripts

```sh
./build.sh      # ensure repo deps are installed (the service runs via tsx)
./start.sh      # start the loop (backgrounded, PID-file tracked, logs → logs/)
./stop.sh       # SIGTERM (clean stop); -f/--force escalates to sudo kill -9
./status.sh     # PID liveness + last "processed" line + recent logs
./watchdog.sh   # cron-friendly: restart if down (+ optional Healthchecks ping)
./update.sh     # stop → git pull → build → start
```

Quick sanity check before supervising it: `pnpm research-trader-worker --once`
drains the queue once and exits.

## Deploy on the NAS (cron watchdog — the supervised path)

```sh
./build.sh           # one-time: install deps
./start.sh           # launch the loop
crontab -e           # add the watchdog (restart-if-down) every 5 min:
# */5 * * * * /opt/hl-cockpit/services/research-trader-worker/watchdog.sh >> /opt/hl-cockpit/services/research-trader-worker/logs/watchdog.log 2>&1
```

(A `systemd/research-trader-worker.service` unit is included for reference if you
ever switch to systemd — `Restart=always` replaces the watchdog cron. Don't run
both.)

## Configuration

Reads the **repo's** env (`.env.local` — `pnpm env:pull`). Needs the same Supabase
service-role keys the cockpit uses (the new project's `HL_TRADERS_*`):

- `HL_TRADERS_SUPABASE_URL` (or `HL_SUPABASE_URL` fallback)
- `HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY` (or `..._SECRET_KEY`)

Optional dead-man's switch: set `HEALTHCHECKS_RESEARCH_WORKER_URL` in this dir's
`.env` and the watchdog pings it (`/fail` on a restart).

## Without this running

"Vet copyability →" in the cockpit just queues a request that never processes (the
drawer shows the prior evaluation, or "Not yet vetted"). Favorites-gated trader-watch
and the cockpit are unaffected — only on-demand vetting depends on this worker.
