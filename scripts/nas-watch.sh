#!/bin/sh
# nas-watch.sh — one NAS-cron tick for the HL cockpit monitoring stack.
#
# Runs a single cycle of: (1) health watch (per-coin health/P&L/alerts -> Supabase),
# (2) rubric scan (deterministic opportunity scan + position reviews + market_snapshots
# -> Supabase), and (3) an OPTIONAL auto-exit poke (pokes the Vercel executor; only
# fires when a CRON_SECRET is present). LEADER-watch is intentionally NOT here — the
# always-on `services/trader-watch` daemon already keeps leader_positions fresh ~every
# 30s, so a 5-min `--once` tick here would just double-write (wasted HL calls).
#
# DEAD-MAN'S SWITCH: if HEALTHCHECKS_NAS_WATCH_URL is set (env) or a
# `$REPO/.healthchecks-nas-watch-url` file exists, each tick pings Healthchecks.io
# (/start at the top, success at the end, /fail on any errored step or early exit).
# Configure a ~10-15m period there so a SILENT stall (expired token, pnpm off PATH,
# repo moved) pages you instead of letting market_snapshots/rubric/health go stale.
#
# Designed for cron's minimal PATH (the usual reason "it works in SSH but not in cron"):
# it sources the login profiles + nvm and adds the common node/pnpm bin dirs, then
# resolves pnpm explicitly.
#
# Install (on the NAS):
#   chmod +x /volume1/home/admin/hyperliquid/scripts/nas-watch.sh
#   mkdir -p /volume1/home/admin/hyperliquid/logs
#   # crontab line (every 5 min):
#   */5 * * * * /volume1/home/admin/hyperliquid/scripts/nas-watch.sh >> /volume1/home/admin/hyperliquid/logs/nas-watch.log 2>&1
#
# For the auto-exit poke, provide the secret OUT of git (same value as Vercel CRON_SECRET):
#   echo 'YOUR_CRON_SECRET' > /volume1/home/admin/hyperliquid/.auto-exit-secret && chmod 600 /volume1/home/admin/hyperliquid/.auto-exit-secret
# (or export AUTO_EXIT_CRON_SECRET in the environment). Without it, the poke is skipped.
#
# For the dead-man's switch, provide the Healthchecks.io ping URL OUT of git:
#   echo 'https://hc-ping.com/YOUR-UUID' > /volume1/home/admin/hyperliquid/.healthchecks-nas-watch-url && chmod 600 ...
# (or export HEALTHCHECKS_NAS_WATCH_URL). Without it, pinging is skipped (no-op).

REPO="${HL_COCKPIT_DIR:-/volume1/home/admin/hyperliquid}"
AUTO_EXIT_URL="${AUTO_EXIT_URL:-https://hyperliquid-rouge.vercel.app/api/cron/auto-exit}"

# --- make pnpm/node findable under cron's minimal PATH ---
for p in /etc/profile "$HOME/.profile"; do [ -f "$p" ] && . "$p" >/dev/null 2>&1; done
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/usr/local/bin:/opt/bin:/opt/sbin:$HOME/.local/share/pnpm:$HOME/.npm-global/bin:/usr/local/node/bin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

# Healthchecks.io ping. Resolve from env first (file is added after the repo cd).
# hc <suffix>: suffix is '' (success), '/start', or '/fail'. No-op when unconfigured.
HC_URL="${HEALTHCHECKS_NAS_WATCH_URL:-}"
hc() {
  [ -n "$HC_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -m 10 --retry 3 "${HC_URL}$1" >/dev/null 2>&1 || true
}

cd "$REPO" 2>/dev/null || { log "ERROR: repo not found at $REPO (set HL_COCKPIT_DIR)"; hc "/fail"; exit 1; }

# Augment the ping URL from an out-of-git file if env didn't provide it.
[ -z "$HC_URL" ] && [ -f "$REPO/.healthchecks-nas-watch-url" ] && HC_URL="$(cat "$REPO/.healthchecks-nas-watch-url" 2>/dev/null | tr -d '\r\n')"

PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then
  log "ERROR: pnpm not on PATH. Run 'command -v pnpm' in an SSH shell and add that dir to PATH at the top of this script."
  hc "/fail"
  exit 1
fi

# Run a labelled pnpm step, indent its output, and flag ERR on a non-zero exit
# (the pipe to sed would otherwise mask the exit code — capture it first).
ERR=0
run_step() {
  desc="$1"; shift
  log "-> $desc"
  if out="$("$@" 2>&1)"; then
    [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/   /'
  else
    [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/   /'
    log "   ^ step FAILED (exit non-zero)"
    ERR=1
  fi
}

hc "/start"
log "=== nas-watch tick (repo=$REPO) ==="

# Health watch: per-coin health/P&L/alerts for open paper positions -> Supabase.
run_step "health watch (pnpm watch --once)" "$PNPM" watch --once

# Rubric: deterministic opportunity scan + per-position reviews -> Supabase
# (rubric_scores + market_snapshots). Read-only HL + Supabase-write (no agent key);
# the leader-consensus pillar reads leader_positions kept fresh by the always-on
# trader-watch daemon. NEVER trades.
run_step "rubric scan (pnpm rubric --once)" "$PNPM" rubric --once

# --- optional auto-exit poke (secret kept OUT of git) ---
SECRET="${AUTO_EXIT_CRON_SECRET:-}"
[ -z "$SECRET" ] && [ -f "$REPO/.auto-exit-secret" ] && SECRET="$(cat "$REPO/.auto-exit-secret" 2>/dev/null | tr -d '\r\n')"
if [ -n "$SECRET" ]; then
  log "-> auto-exit poke ($AUTO_EXIT_URL)"
  curl -s -m 30 -H "Authorization: Bearer $SECRET" "$AUTO_EXIT_URL" 2>&1 | sed 's/^/   /'
  echo ""
else
  log "-> auto-exit poke SKIPPED (no AUTO_EXIT_CRON_SECRET env and no $REPO/.auto-exit-secret file)"
fi

if [ "$ERR" -eq 0 ]; then
  log "=== tick done (ok) ==="
  hc ""
else
  log "=== tick done (with errors) ==="
  hc "/fail"
fi
