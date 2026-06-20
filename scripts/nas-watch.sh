#!/bin/sh
# nas-watch.sh — one NAS-cron tick for the HL cockpit monitoring stack.
#
# Runs a single cycle of: (1) health watch (per-coin health/P&L/alerts -> Supabase),
# (2) leader watch (top-50 leaders' positions -> Supabase), and (3) an OPTIONAL
# auto-exit poke (pokes the Vercel executor; only fires when AUTO_EXIT_ENABLED=true).
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

REPO="${HL_COCKPIT_DIR:-/volume1/home/admin/hyperliquid}"
AUTO_EXIT_URL="${AUTO_EXIT_URL:-https://hyperliquid-rouge.vercel.app/api/cron/auto-exit}"
TOP_N="${HL_TOP_N:-50}"

# --- make pnpm/node findable under cron's minimal PATH ---
for p in /etc/profile "$HOME/.profile"; do [ -f "$p" ] && . "$p" >/dev/null 2>&1; done
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/usr/local/bin:/opt/bin:/opt/sbin:$HOME/.local/share/pnpm:$HOME/.npm-global/bin:/usr/local/node/bin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

cd "$REPO" 2>/dev/null || { log "ERROR: repo not found at $REPO (set HL_COCKPIT_DIR)"; exit 1; }

PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then
  log "ERROR: pnpm not on PATH. Run 'command -v pnpm' in an SSH shell and add that dir to PATH at the top of this script."
  exit 1
fi

log "=== nas-watch tick (repo=$REPO) ==="

log "-> health watch (pnpm watch --once)"
"$PNPM" watch --once 2>&1 | sed 's/^/   /'

log "-> leader watch (pnpm trader-watch --once --top $TOP_N)"
"$PNPM" trader-watch --once --top "$TOP_N" 2>&1 | sed 's/^/   /'

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

log "=== tick done ==="
