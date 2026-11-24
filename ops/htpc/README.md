# HTPC scout consumer

The HTPC (`TactixServer`, Windows 10, Tailscale `100.120.86.158`) runs the headless
scout consumer in WSL 2 (`Ubuntu-24.04`, user `tony`). The NAS keeps the zero-token
scout-watch daemon, and the Sonnet step moves off the NAS.

A 5-minute systemd user timer runs `scout-consumer.sh`. The script asks
`pnpm scout:consumer-due` whether a cycle is due. It keeps the daemon's old cadences:
every 30 minutes, or after 10 minutes when an act trigger waits. Then it runs
`scripts/scout-headless.sh` with a 10-minute limit. The trade path stays paper-only
(`assertScoutPaperMode`).

## What the box has

- WSL 2 with systemd on (`/etc/wsl.conf`) and `tony` as the default user.
- The Windows task "WSL keepalive" runs at the `tactix` logon (the HTPC logs in
  automatically). It starts `wsl.exe -d Ubuntu-24.04 --exec sleep infinity` with a
  hidden window through `C:\Users\Tactix\wsl-keepalive.vbs`. Without it, WSL stops the
  distro and the timer with it.
- Node 24 (nvm), pnpm, and the claude CLI at `~/.local/bin/claude`.
- The repo at `~/gitrepos/hyperliquid`, cloned with the read-only deploy key
  "HTPC scout (read-only)".
- `.env.local` with `TRADING_MODE=paper` and only the Supabase, Discord and HL
  account keys. It holds no admin secret, no poke bearer and no agent key.
- `~/.config/hl-scout/env` (mode 600) with `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`. Never set `ANTHROPIC_API_KEY`.

## Install the timer

```sh
mkdir -p ~/.config/systemd/user
ln -sf ~/gitrepos/hyperliquid/ops/htpc/hl-scout-consumer.service ~/.config/systemd/user/
ln -sf ~/gitrepos/hyperliquid/ops/htpc/hl-scout-consumer.timer ~/.config/systemd/user/
systemctl --user daemon-reload
loginctl enable-linger tony
```

## Cut-over (one consumer only)

1. NAS, as admin: add `SCOUT_CONSUMER_INTERVAL_MIN=0` to
   `/volume1/home/admin/hyperliquid/services/scout-watch/.env`, then restart the
   daemon: `sh services/scout-watch/stop.sh && sh services/scout-watch/start.sh`.
   The daemon keeps its triggers, exit enforcement and heartbeat.
2. HTPC: `systemctl --user enable --now hl-scout-consumer.timer`.
3. Check: `journalctl --user -u hl-scout-consumer -n 20` shows `due` or `wait`
   lines, and the `scout-cycle` heartbeat stays under 35 minutes old.

Rollback: HTPC `systemctl --user disable --now hl-scout-consumer.timer`, then remove
the line from the NAS `.env` and restart the daemon.

## Update

`cd ~/gitrepos/hyperliquid && git pull && pnpm install --frozen-lockfile`. The next
tick uses the new code, so no restart is needed.
