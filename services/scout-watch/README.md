# Scout-Watch Daemon (autonomous PAPER scout — free trigger layer)

The **deterministic, FREE, no-model** layer of the autonomous paper scout. Runs on
your always-on **office dev machine** (paper-only — manual live trading happens
separately from your laptop/phone via the cockpit approval popup, so this box never
touches real money). Every ~60s it reads the latest rubric scores + fresh marks +
open paper positions and appends *material triggers* to a JSONL file the scout
session watches. Costs **zero model tokens**.

> **WATCH-ONLY / PAPER-ONLY.** This daemon never places a trade — it only writes
> triggers + a `scout_heartbeat` row. The trade path (`scout:trade`) lives in the
> separate interactive scout session and is hard-guarded by `assertScoutPaperMode`
> (throws in live mode → fails safe).

## The scout is TWO processes

1. **This daemon** (`scout:watch`, headless) — supervise it with the scripts here
   or the `systemd --user` unit. Auto-restarts.
2. **The scout session** (a Claude Code session on **Sonnet**) — interactive; it
   reads the triggers and makes the paper calls. You leave it running in a terminal
   / tmux; it self-paces via a Monitor on the trigger file + scheduled wake-ups.
   It inherits paper mode from the repo's `.env.local` (`TRADING_MODE="paper"`).

See `docs/scout/README.md` for the full runbook + the pre-registered success bar.

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
