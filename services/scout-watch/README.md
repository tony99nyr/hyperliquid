# Scout-Watch Daemon (autonomous PAPER scout — free trigger layer)

The **deterministic, FREE, no-model** layer of the autonomous paper scout. Runs on
your always-on **office dev machine** (paper-only: this box never touches real money).
Every 120s by default it reads the latest rubric scores + fresh marks + open paper
positions and writes *material triggers* to the Supabase `scout_triggers` table (JSONL
is the offline fallback). Costs **zero model tokens**.

> **WATCH-ONLY / PAPER-ONLY.** The daemon itself never places a trade. It writes
> triggers + a `scout_heartbeat` row. The trade path (`scout:trade`) is hard-guarded by
> `assertScoutPaperMode` (throws in live mode → fails safe).

## What runs in this one process

1. **The trigger producer** (`scout:watch`): supervise it with the scripts here or the
   `systemd --user` unit. Auto-restarts.
2. **The embedded consumer**: every `SCOUT_CONSUMER_INTERVAL_MIN` (default 30) the
   daemon spawns `scripts/scout-headless.sh` (snapshot → headless Sonnet decision →
   strict-JSON paper trade). Do NOT add a separate consumer cron as well: two consumers
   can both open on the same directive.
3. **The prod-cron poker**: every 10 min it pokes `/api/cron/auto-exit` and
   `/api/cron/reconcile-positions` with `AUTO_EXIT_CRON_SECRET` from `.env.local`.
   Rotating that secret needs a `.env.local` update here as well as on the NAS.

Paper mode does NOT come from `.env.local` (which has no `TRADING_MODE`). Three pins set
it: `start.sh` (`export TRADING_MODE=paper`), the systemd unit
(`Environment="TRADING_MODE=paper"`), and the child-process pin in
`src/lib/scout/scout-exit-enforcement-service.ts`.

See `docs/scout/README.md` for the scout architecture and runbook.

## Supervise the daemon — option A: systemd --user (recommended on this box)

```sh
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/systemd/hl-scout-watch.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hl-scout-watch
loginctl enable-linger "$USER"     # survive logout / start without an active login
systemctl --user status hl-scout-watch
journalctl --user -u hl-scout-watch -f
```

**WSL caveat:** systemd only runs while WSL is up. If every WSL terminal closes,
the distro can stop and the service with it. Add a Windows Task-Scheduler task at
logon running `wsl.exe -d <distro> -u <user> --exec /bin/true` so the distro (and
this service) start with Windows. On native Linux, `enable-linger` alone suffices.

## Supervise the daemon — option B: shell scripts + cron watchdog

```sh
./build.sh        # ensure deps (runs via tsx)
./start.sh        # start (writes scout-watch.pid, logs to logs/)
./status.sh       # PID + last tick + recent logs
./stop.sh         # graceful SIGTERM
./update.sh       # stop → git pull → install → start
# keep-alive: crontab → */3 * * * * cd <this dir> && /bin/sh watchdog.sh >> logs/watchdog.log 2>&1
```

Use **one** supervisor, not both (systemd `Restart=always` OR the cron watchdog).

## Dead-man's switch (optional)

`watchdog.sh` pings Healthchecks.io if `HEALTHCHECKS_SCOUT_WATCH_URL` is set (env or
a `.env` file in this dir, kept out of git). Configure a ~5–10m period so a silent
stall pages you. (If you use the systemd unit instead of the cron watchdog, monitor
liveness via `scout_heartbeat` in Supabase / the cockpit ScoutPanel.)
