# Scout-Watch Daemon (autonomous PAPER scout — free trigger layer)

The **deterministic, FREE, no-model** layer of the autonomous paper scout. Runs on
the office box until the NAS cut-over below (paper-only: it never touches real money).
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
3. **The fallback prod-cron poker**: every 10 min it checks the `reconcile` and
   `auto-exit-cron` heartbeats. When the NAS stamped both in the last 12 min and no
   NAS poke failed, it does nothing. Otherwise it pokes `/api/cron/auto-exit` and `/api/cron/reconcile-positions`
   with `AUTO_EXIT_CRON_SECRET` from `.env.local`.
   Rotating that secret needs a `.env.local` update here as well as on the NAS.

Paper mode does NOT come from `.env.local` (which has no `TRADING_MODE`). Three pins set
it: `start.sh` (`export TRADING_MODE=paper`), the systemd unit
(`Environment="TRADING_MODE=paper"`), and the child-process pin in
`src/lib/scout/scout-exit-enforcement-service.ts`.

See `docs/scout/README.md` for the scout architecture and runbook.

## Run it on the NAS (cut-over planned 2026-11-23)

The office PC is to sleep at night, so scout-watch moves to the NAS.
`ops/nas/install.sh` installs it in root's crontab, beside trader-watch, and it
also moves the Monday desk-retro reminder. The daemon runs as root, like the other
NAS services. The office box keeps its systemd unit only as a rollback.

The embedded consumer (`scripts/scout-headless.sh`, every 30 min) does the same
work as the interactive scout Claude session on the office box: `scout:cycle`, one
Sonnet decision, a paper trade or a stand-down, and a Discord ping for a steward
proposal. A dead consumer pages Discord through the stale `scout-cycle` heartbeat.
So the NAS daemon replaces that session too. Stop the session at cut-over: two
consumers can both open on the same directive.

**Never run two daemons.** Two daemons double-write triggers. `install-scout`
refuses while the `scout-watch` heartbeat is younger than 5 minutes and comes
from another host. The heartbeat `detail` ends in `host=<hostname>`.

What the NAS needs first (never commit these):

- `.env.local` in the repo, with the Supabase service-role keys and
  `DISCORD_WEBHOOK_URL`. `check` names each missing key. `install-scout` copies the
  poke bearer from `.auto-exit-secret` to `services/scout-watch/.env`.
- A subscription token for the claude CLI. As admin on the NAS, run
  `/volume1/home/admin/.local/bin/claude setup-token`, sign in with the
  subscription, and add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to
  `services/scout-watch/.env` (`chmod 600`). Never set `ANTHROPIC_API_KEY`.

The daemon state file (`~/.hl-cockpit-scout-state.json`) does not move. The NAS
daemon starts from a fresh baseline, so it can miss a trigger in its first cycle.

Cut-over, in this order:

1. NAS, as admin: `cd /volume1/home/admin/hyperliquid && git pull origin main && sh ops/nas/install.sh check --probe-claude`.
   Fix each FAIL line.
2. NAS: `sudo sh ops/nas/install.sh install-retro`. When the test ping reaches Discord,
   disable the office retro timer: `systemctl --user disable --now desk-retro-reminder.timer`.
3. Office box: `systemctl --user disable --now scout-watch` (on a box set up with
   option A below the unit is `hl-scout-watch`), so a reboot cannot start it again.
   Stop the scout
   Claude session's loop. Check `pgrep -f scripts/scout-watch.ts` prints nothing.
   Wait 5 minutes.
4. NAS: `sudo sh ops/nas/install.sh install-scout --office-stopped`. It starts the daemon and waits for
   the first consumer cycle (up to 12 minutes). The summary shows its memory.
5. The summary must show a NAS heartbeat and `consumer exit=0`. If the first consumer
   cycle has not run yet, run `sh ops/nas/install.sh status` after 30 minutes.

Rollback: NAS `sudo sh ops/nas/install.sh uninstall-scout`, then office box
`systemctl --user enable --now scout-watch` (or `hl-scout-watch`).

After a push that touches scout code: NAS `sudo sh services/scout-watch/update.sh`
(pull, install, restart). Check it any time with `sh ops/nas/install.sh status`.

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
