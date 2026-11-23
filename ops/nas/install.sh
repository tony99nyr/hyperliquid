#!/bin/sh
# ops/nas/install.sh: run the office-box jobs of this repo on the NAS.
#
# Two jobs move here (2026-11-23, so the office PC can sleep at night):
#   - scout-watch: the always-on paper scout daemon (services/scout-watch).
#   - desk-retro reminder: the Monday 12:57 Discord ping (pnpm retro:remind).
#
# Run it on the NAS as admin (the user whose crontab runs trader-watch), from the
# repo, after a pull:
#   cd /volume1/home/admin/hyperliquid && git pull origin main && sh ops/nas/install.sh check
#
# Commands:
#   check [--probe-claude]  Preflight. Changes nothing. --probe-claude runs one tiny
#                           `claude -p` call to prove the subscription login.
#   install-retro           Add the Monday 12:57 cron line and send a Discord test ping.
#   install-scout           Add the scout-watch cron lines (@reboot start, */3 watchdog),
#                           start the daemon and wait for its first consumer cycle.
#                           REFUSES while another box writes a fresh scout-watch
#                           heartbeat: stop the office-box unit first.
#   uninstall-scout         Remove the scout-watch cron lines and stop the daemon.
#   uninstall-retro         Remove the desk-retro cron line.
#   status                  Daemon, heartbeat, cron lines, last consumer result.
#   run-retro               What the cron line runs: the Monday reminder.
#
# Update after a push to main: sh services/scout-watch/update.sh (pull, install, restart).
# Paste the lines from "=== SUMMARY ===" down into the desk session.
#
# AUTH POLICY: the claude CLI runs on Tony's subscription (a one-time `claude` login
# as admin on the NAS). This script FAILS when it finds ANTHROPIC_API_KEY.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCOUT_DIR="$REPO/services/scout-watch"
SCOUT_ENV="$SCOUT_DIR/.env"
TAG_SCOUT="# hl-nas:scout-watch"
TAG_RETRO="# hl-nas:desk-retro"
# A heartbeat younger than this means a scout-watch daemon still runs somewhere.
FRESH_SEC=300
HOST="$(hostname 2>/dev/null)"

cd "$REPO" || exit 1
mkdir -p logs "$SCOUT_DIR/logs"

SUMMARY=""
FAILS=0
WARNS=0
note() { SUMMARY="$SUMMARY
$1"; echo "$1"; }
pass() { note "PASS  $1"; }
warn() { note "WARN  $1"; WARNS=$((WARNS + 1)); }
fail() { note "FAIL  $1"; FAILS=$((FAILS + 1)); }
summary() {
  echo ""
  echo "=== SUMMARY ($1, $(date '+%Y-%m-%d %H:%M %Z'), host=$HOST, user=$(id -un 2>/dev/null)) ==="
  echo "$SUMMARY" | sed '/^$/d'
  echo "RESULT: $FAILS fail, $WARNS warn"
}

# --- helpers -----------------------------------------------------------------

# has_key NAME: the key has a value in the environment or in .env.local.
has_key() {
  eval "v=\${$1:-}"
  [ -n "$v" ] && return 0
  grep -q "^$1=..*" .env.local 2>/dev/null
}

# cron_replace TAG LINES: drop every crontab line that ends in TAG, then append LINES.
cron_replace() {
  tag="$1"
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -vF "$tag" > "$tmp"
  [ -n "$2" ] && printf '%s\n' "$2" >> "$tmp"
  crontab "$tmp" && rm -f "$tmp"
}

cron_has() { crontab -l 2>/dev/null | grep -qF "$1"; }

# heartbeat: sets HB_AGE (seconds, "none" or "error") and HB_DETAIL.
heartbeat() {
  out="$(pnpm --silent scout:heartbeat 2>&1 | grep '^age_sec=' | tail -1)"
  HB_AGE="$(echo "$out" | sed -n 's/^age_sec=\([^ ]*\).*/\1/p')"
  HB_DETAIL="$(echo "$out" | sed -n 's/.* detail=//p')"
  [ -n "$HB_AGE" ] || HB_AGE="error"
}

scout_pid() { ps -ef 2>/dev/null | grep "[s]cripts/scout-watch.ts" | awk '{print $2}' | head -1; }

resolve_claude() {
  CLAUDE=""
  if [ -f "$SCOUT_ENV" ]; then
    CLAUDE="$(sed -n 's/^CLAUDE_BIN=//p' "$SCOUT_ENV" | tail -1)"
  fi
  [ -n "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null)"
}

# --- preflight ----------------------------------------------------------------

preflight() {
  note "repo $REPO at $(git log -1 --format='%h %cd' --date=short 2>/dev/null)"
  if [ -f scripts/scout-heartbeat-check.ts ]; then
    pass "checkout has the NAS install support"
  else
    fail "checkout is older than the NAS install support (run: git pull origin main)"
  fi
  [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] \
    && pass "checkout has no local edits" \
    || warn "checkout has local edits (git status): update.sh may fail to pull"

  if . ./ops/node-env.sh 2>/dev/null; then pass "node $("$HL_NODE" -v) at $HL_NODE"; else fail "no Node >= 24 (see ops/node-env.sh)"; fi
  if command -v pnpm >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1; then
    pass "pnpm $(pnpm -v)"
  else
    fail "pnpm not usable on PATH (npm i -g pnpm, with the Node 24 PATH exported)"
  fi
  [ -x node_modules/.bin/tsx ] && pass "tsx installed" || fail "node_modules/.bin/tsx missing (run: sh services/scout-watch/build.sh)"

  [ -f .env.local ] && pass ".env.local present" || fail ".env.local missing (copy it from the office box)"
  if has_key HL_TRADERS_SUPABASE_URL || has_key HL_SUPABASE_URL || has_key SUPABASE_URL; then pass "Supabase URL set"; else fail "no Supabase URL in .env.local"; fi
  if has_key HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY || has_key HL_SUPABASE_SERVICE_ROLE_KEY || has_key SUPABASE_SERVICE_ROLE_KEY \
     || has_key HL_TRADERS_SUPABASE_SECRET_KEY || has_key HL_SUPABASE_SECRET_KEY; then
    pass "Supabase service-role key set"
  else
    fail "no Supabase service-role key in .env.local"
  fi
  if has_key DISCORD_WEBHOOK_URL; then pass "DISCORD_WEBHOOK_URL set"; else fail "DISCORD_WEBHOOK_URL missing from .env.local (retro reminder, scout alerts)"; fi
  if has_key AUTO_EXIT_CRON_SECRET; then
    pass "AUTO_EXIT_CRON_SECRET set (scout-watch fallback poker)"
  else
    warn "AUTO_EXIT_CRON_SECRET not in .env.local: the scout-watch fallback poke is off (nas-watch still pokes)"
  fi
  if has_key ANTHROPIC_API_KEY || grep -q '^ANTHROPIC_API_KEY=' "$SCOUT_ENV" 2>/dev/null; then
    fail "ANTHROPIC_API_KEY is set: remove it (desk policy: subscription login only)"
  else
    pass "no ANTHROPIC_API_KEY"
  fi

  resolve_claude
  if [ -n "$CLAUDE" ] && [ -x "$CLAUDE" ]; then
    pass "claude $("$CLAUDE" --version 2>/dev/null | head -1) at $CLAUDE"
    if [ -f "$HOME/.claude/.credentials.json" ] || grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$SCOUT_ENV" 2>/dev/null; then
      pass "claude login found for $(id -un 2>/dev/null) (HOME=$HOME)"
    else
      warn "no claude login in $HOME/.claude: run 'claude' once as $(id -un 2>/dev/null) and sign in with the subscription"
    fi
    if [ "$PROBE_CLAUDE" = 1 ]; then
      reply="$(printf 'Reply with the single word OK.' | "$CLAUDE" -p --model haiku 2>&1 | head -3)"
      case "$reply" in
        *OK*) pass "claude -p answered on the subscription" ;;
        *) fail "claude -p did not answer OK: $reply" ;;
      esac
    fi
  else
    fail "claude CLI not found (install with the Node 24 PATH: npm i -g @anthropic-ai/claude-code, or set CLAUDE_BIN in services/scout-watch/.env)"
  fi

  avail="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  swap_used="$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo 2>/dev/null)"
  if [ -n "$avail" ] && [ "$avail" -ge 800 ]; then
    pass "memory available ${avail} MB, swap used ${swap_used} MB"
  else
    warn "memory available ${avail:-?} MB, swap used ${swap_used:-?} MB: scout-watch needs about 300 MB, plus about 300 MB during each claude call"
  fi

  case "$(date +%z)" in
    -0500|-0400) pass "timezone $(date +%Z) (cron times are New York time)" ;;
    *) warn "timezone $(date +%Z) $(date +%z): the retro line fires at 12:57 NAS time, not New York time (fix the NAS timezone in ADM Settings)" ;;
  esac

  heartbeat
  case "$HB_AGE" in
    error) fail "cannot read the scout-watch heartbeat from Supabase" ;;
    none) pass "no scout-watch heartbeat row yet" ;;
    *) note "INFO  scout-watch heartbeat ${HB_AGE}s old: $HB_DETAIL" ;;
  esac
  pid="$(scout_pid)"
  [ -n "$pid" ] && note "INFO  scout-watch runs on this NAS (PID $pid)" || note "INFO  scout-watch does not run on this NAS"
  cron_has "$TAG_SCOUT" && note "INFO  scout-watch cron lines installed" || note "INFO  scout-watch cron lines not installed"
  cron_has "$TAG_RETRO" && note "INFO  desk-retro cron line installed" || note "INFO  desk-retro cron line not installed"
}

# --- commands -----------------------------------------------------------------

cmd_install_retro() {
  preflight
  if [ "$FAILS" -gt 0 ]; then note "STOP  fix the FAIL lines, then run install-retro again"; return; fi
  cron_replace "$TAG_RETRO" "57 12 * * 1 /bin/sh $REPO/ops/nas/install.sh run-retro >> $REPO/logs/desk-retro-reminder.log 2>&1 $TAG_RETRO"
  cron_has "$TAG_RETRO" && pass "desk-retro cron line installed (Mon 12:57)" || fail "crontab did not take the desk-retro line"
  if pnpm --silent retro:remind --test; then
    pass "Discord test ping sent: check the channel for 'Test ping from $HOST'"
  else
    fail "Discord test ping failed (see the output above)"
  fi
}

cmd_install_scout() {
  preflight
  if [ "$FAILS" -gt 0 ]; then note "STOP  fix the FAIL lines, then run install-scout again"; return; fi
  pid="$(scout_pid)"
  if [ -z "$pid" ]; then
    # The interlock: a fresh heartbeat from another host means the office box still runs it.
    case "$HB_AGE" in
      none) ;;
      *[!0-9]*) fail "heartbeat age unreadable ($HB_AGE)"; return ;;
      *)
        if [ "$HB_AGE" -lt "$FRESH_SEC" ]; then
          fail "another scout-watch wrote a heartbeat ${HB_AGE}s ago ($HB_DETAIL). On the office box run 'systemctl --user stop scout-watch', wait 5 minutes, then run install-scout again"
          return
        fi ;;
    esac
  fi

  resolve_claude
  if ! grep -q '^CLAUDE_BIN=' "$SCOUT_ENV" 2>/dev/null; then
    echo "CLAUDE_BIN=$CLAUDE" >> "$SCOUT_ENV" && chmod 600 "$SCOUT_ENV"
    pass "wrote CLAUDE_BIN=$CLAUDE to services/scout-watch/.env"
  fi

  cron_replace "$TAG_SCOUT" "@reboot sleep 60 && cd $SCOUT_DIR && /bin/sh start.sh >> logs/cron-start.log 2>&1 $TAG_SCOUT
*/3 * * * * cd $SCOUT_DIR && /bin/sh watchdog.sh >> logs/watchdog.log 2>&1 $TAG_SCOUT"
  cron_has "$TAG_SCOUT" && pass "scout-watch cron lines installed (@reboot, */3 watchdog)" || { fail "crontab did not take the scout-watch lines"; return; }

  if [ -z "$pid" ]; then
    (cd "$SCOUT_DIR" && /bin/sh start.sh)
  fi
  echo "Waiting up to 12 minutes for the first tick and the first consumer cycle..."
  log="$SCOUT_DIR/logs/scout-watch.log"
  i=0
  while [ "$i" -lt 48 ]; do
    sleep 15
    i=$((i + 1))
    grep -q 'consumer exit=' "$log" 2>/dev/null && break
    [ -n "$(scout_pid)" ] || break
  done
  report_scout
}

report_scout() {
  log="$SCOUT_DIR/logs/scout-watch.log"
  pid="$(scout_pid)"
  [ -n "$pid" ] && pass "scout-watch runs (PID $pid)" || fail "scout-watch is not running (tail of $log below)"
  heartbeat
  case "$HB_DETAIL" in
    *"host=$HOST"*)
      if [ "$HB_AGE" -lt "$FRESH_SEC" ] 2>/dev/null; then pass "heartbeat ${HB_AGE}s old from this NAS: $HB_DETAIL"; else fail "heartbeat from this NAS is ${HB_AGE}s old"; fi ;;
    *) fail "heartbeat ${HB_AGE}s old is not from this NAS: $HB_DETAIL" ;;
  esac
  last="$(grep 'consumer exit=' "$log" 2>/dev/null | tail -1)"
  case "$last" in
    *"consumer exit=0"*) pass "last consumer cycle: $(echo "$last" | cut -c1-200)" ;;
    "") warn "no consumer cycle in the log yet (it runs every 30 min): run status later" ;;
    *) fail "last consumer cycle failed: $(echo "$last" | cut -c1-200)" ;;
  esac
  echo "--- tail of $log ---"
  tail -8 "$log" 2>/dev/null
  echo "---"
}

cmd_uninstall_scout() {
  cron_replace "$TAG_SCOUT" ""
  cron_has "$TAG_SCOUT" && fail "scout-watch cron lines still present" || pass "scout-watch cron lines removed"
  (cd "$SCOUT_DIR" && /bin/sh stop.sh)
  sleep 5
  [ -z "$(scout_pid)" ] && pass "scout-watch stopped on this NAS" || fail "scout-watch still runs (sh services/scout-watch/stop.sh --force)"
}

cmd_uninstall_retro() {
  cron_replace "$TAG_RETRO" ""
  cron_has "$TAG_RETRO" && fail "desk-retro cron line still present" || pass "desk-retro cron line removed"
}

cmd_status() {
  . ./ops/node-env.sh 2>/dev/null || fail "no Node >= 24"
  report_scout
  cron_has "$TAG_SCOUT" && pass "scout-watch cron lines installed" || warn "scout-watch cron lines not installed"
  if cron_has "$TAG_RETRO"; then
    pass "desk-retro cron line installed"
    last="$(grep 'desk-retro-reminder:' logs/desk-retro-reminder.log 2>/dev/null | tail -1)"
    [ -n "$last" ] && note "INFO  last retro run: $last"
  else
    warn "desk-retro cron line not installed"
  fi
}

PROBE_CLAUDE=0
[ "$2" = "--probe-claude" ] && PROBE_CLAUDE=1

case "$1" in
  check) preflight; summary check ;;
  install-retro) cmd_install_retro; summary install-retro ;;
  install-scout) cmd_install_scout; summary install-scout ;;
  uninstall-scout) cmd_uninstall_scout; summary uninstall-scout ;;
  uninstall-retro) cmd_uninstall_retro; summary uninstall-retro ;;
  status) cmd_status; summary status ;;
  run-retro)
    . ./ops/node-env.sh || exit 1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] desk-retro run"
    exec pnpm --silent retro:remind ;;
  *) sed -n '2,27p' "$0"; exit 2 ;;
esac
[ "$FAILS" -eq 0 ]
