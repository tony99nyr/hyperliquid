#!/bin/sh
# ops/nas/install.sh: run the office-box jobs of this repo on the NAS.
#
# Two jobs move here (2026-11-23, so the office PC can sleep at night):
#   - scout-watch: the always-on paper scout daemon (services/scout-watch).
#   - desk-retro reminder: the Monday 12:57 Discord ping (pnpm retro:remind).
#
# The NAS cron jobs run from root's crontab (as trader-watch does), so every
# install and uninstall command needs root. check and status also work as admin.
#   cd /volume1/home/admin/hyperliquid && git pull origin main
#   sh ops/nas/install.sh check --probe-claude          (as admin)
#   sudo sh ops/nas/install.sh install-scout --office-stopped   (as root)
# The jobs themselves run as admin (su from root's crontab), never as root.
#
# Commands:
#   check [--probe-claude]  Preflight. Changes nothing. --probe-claude runs one tiny
#                           `claude -p` call to prove the subscription login.
#   install-retro           Add the Monday 12:57 cron line and send a Discord test ping.
#   install-scout           Add the scout-watch cron lines (@reboot start, */3 watchdog),
#                           start the daemon and wait for its first consumer cycle.
#                           Needs --office-stopped: Tony confirms that the office
#                           box unit and the scout Claude session are stopped. It
#                           also REFUSES while another box writes a fresh heartbeat
#                           (a stale row alone does not prove the other daemon died).
#   uninstall-scout         Remove the scout-watch cron lines and stop the daemon.
#   uninstall-retro         Remove the desk-retro cron line.
#   status                  Daemon, heartbeat, cron lines, last consumer result.
#
# Update after a push to main, as admin: sh services/scout-watch/update.sh (pull, install, restart).
# Paste the lines from "=== SUMMARY ===" down into the desk session.
#
# AUTH POLICY: the claude CLI runs on Tony's subscription: a CLAUDE_CODE_OAUTH_TOKEN
# line in services/scout-watch/.env, made once with `claude setup-token`. This script FAILS when it finds ANTHROPIC_API_KEY.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCOUT_DIR="$REPO/services/scout-watch"
SCOUT_ENV="$SCOUT_DIR/.env"
LOG="$SCOUT_DIR/logs/scout-watch.log"
TAG_SCOUT="# hl-nas:scout-watch"
TAG_RETRO="# hl-nas:desk-retro"
# A heartbeat younger than this means a scout-watch daemon still runs somewhere.
FRESH_SEC=300
HOST="$(hostname 2>/dev/null)"
[ -n "$HOST" ] || { echo "hostname is empty: cannot tell this box's heartbeat apart" >&2; exit 1; }

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
# Refuses when it cannot read the crontab: writing an empty file would delete every
# other root job. Keeps a backup of the old crontab in /root/crontab-backups.
cron_replace() {
  tag="$1"
  d="$(mktemp -d)" || return 1   # mode 700: root's crontab can hold secrets
  if ! crontab -l > "$d/old" 2>/dev/null; then
    rm -rf "$d"
    fail "cannot read the crontab of $(id -un): run this command with sudo"
    return 1
  fi
  # Backup in root's own folder: admin can plant a symlink in the checkout's logs/.
  (umask 077 && mkdir -p /root/crontab-backups && cp "$d/old" "$(mktemp /root/crontab-backups/crontab.XXXXXX)")
  # grep exits 1 when it keeps no line (fine) and 2 on an error (stop).
  grep -vF "$tag" "$d/old" > "$d/new"
  if [ $? -gt 1 ]; then rm -rf "$d"; fail "could not filter the crontab"; return 1; fi
  [ -n "$2" ] && printf '%s\n' "$2" >> "$d/new"
  crontab "$d/new"
  rc=$?
  rm -rf "$d"
  return $rc
}

cron_has() { crontab -l 2>/dev/null | grep -qF "$1"; }

# cron_note TAG NAME: an INFO line on whether the cron lines are in root's crontab.
cron_note() {
  if [ "$(id -u)" != 0 ]; then note "INFO  $2 cron lines: run with sudo to see root's crontab"
  elif cron_has "$1"; then note "INFO  $2 cron lines installed"
  else note "INFO  $2 cron lines not installed"; fi
}

# The jobs run as the owner of the checkout (admin), not as root: root's cron must not
# run scripts that admin can edit. su -l gives the owner's HOME (claude, git key).
OWNER="$(stat -c %U "$REPO/.git" 2>/dev/null || id -un)"
as_owner() { echo "su -l -s /bin/sh $OWNER -c '$1'"; }
# The jobs write their logs as the owner: a log folder made under sudo must be theirs.
[ "$(id -u)" = 0 ] && chown "$OWNER" "$REPO/logs" "$SCOUT_DIR/logs" 2>/dev/null

need_root() {
  [ "$(id -u)" = 0 ] && return 0
  fail "this command edits root's crontab: run it with sudo"
  return 1
}

# Memory of every process whose command line matches grep pattern $1, in MB.
# Bracket the first letter of the pattern (see ops/pids-of.sh).
rss_mb() {
  total=0
  for pid in $(sh "$REPO/ops/pids-of.sh" "$1"); do
    kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
    total=$((total + ${kb:-0}))
  done
  echo $((total / 1024))
}

# heartbeat: sets HB_AGE (seconds, "none" or "error") and HB_DETAIL.
heartbeat() {
  out="$(pnpm --silent scout:heartbeat 2>&1 | grep '^age_sec=' | tail -1)"
  HB_AGE="$(echo "$out" | sed -n 's/^age_sec=\([^ ]*\).*/\1/p')"
  HB_DETAIL="$(echo "$out" | sed -n 's/.* detail=//p')"
  [ -n "$HB_AGE" ] || HB_AGE="error"
}

scout_pid() { sh "$REPO/ops/pids-of.sh" "[s]cripts/scout-watch.ts" | head -1; }

resolve_claude() {
  CLAUDE=""
  if [ -f "$SCOUT_ENV" ]; then
    CLAUDE="$(sed -n 's/^CLAUDE_BIN=//p' "$SCOUT_ENV" | tail -1)"
  fi
  [ -n "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null)"
  # The NAS install (native installer, as admin). Root's PATH does not have it.
  [ -n "$CLAUDE" ] || { [ -x /volume1/home/admin/.local/bin/claude ] && CLAUDE=/volume1/home/admin/.local/bin/claude; }
}

# --- preflight ----------------------------------------------------------------

preflight() {
  note "repo $REPO at $(git -c safe.directory="$REPO" log -1 --format='%h %cd' --date=short 2>/dev/null)"
  if [ -f scripts/scout-heartbeat-check.ts ]; then
    pass "checkout has the NAS install support"
  else
    fail "checkout is older than the NAS install support (run: git pull origin main)"
  fi
  [ -z "$(git -c safe.directory="$REPO" status --porcelain --untracked-files=no 2>&1)" ] \
    && pass "checkout has no local edits" \
    || warn "checkout has local edits (git status): update.sh may fail to pull"

  if . ./ops/node-env.sh 2>/dev/null; then pass "node $("$HL_NODE" -v) at $HL_NODE"; else fail "no Node >= 24 (see ops/node-env.sh)"; fi
  # Cron PATH has only what node-env.sh adds, so pnpm must sit beside Node 24.
  if [ -x "$(dirname "${HL_NODE:-/x}")/pnpm" ] && pnpm -v >/dev/null 2>&1; then
    pass "pnpm $(pnpm -v) beside Node 24 (found by cron)"
  else
    fail "no pnpm beside Node 24 in $(dirname "${HL_NODE:-?}") (npm i -g pnpm, with the Node 24 PATH exported)"
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
  if has_key AUTO_EXIT_CRON_SECRET || grep -q '^AUTO_EXIT_CRON_SECRET=' "$SCOUT_ENV" 2>/dev/null; then
    pass "AUTO_EXIT_CRON_SECRET set (scout-watch fallback poker)"
  elif [ -s .auto-exit-secret ]; then
    pass "AUTO_EXIT_CRON_SECRET in .auto-exit-secret (install-scout copies it to services/scout-watch/.env)"
  else
    warn "no AUTO_EXIT_CRON_SECRET: the scout-watch fallback poke is off (nas-watch still pokes)"
  fi
  if has_key ANTHROPIC_API_KEY || grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY[[:space:]]*=' .env.local "$SCOUT_ENV" 2>/dev/null; then
    fail "ANTHROPIC_API_KEY is set: remove it (desk policy: subscription login only)"
  else
    pass "no ANTHROPIC_API_KEY"
  fi

  resolve_claude
  if [ -n "$CLAUDE" ] && [ -x "$CLAUDE" ]; then
    pass "claude $("$CLAUDE" --version 2>/dev/null | head -1) at $CLAUDE"
    if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=..' "$SCOUT_ENV" 2>/dev/null; then
      pass "subscription token in services/scout-watch/.env"
      # The probe below must use the same token as the daemon.
      CLAUDE_CODE_OAUTH_TOKEN="$(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' "$SCOUT_ENV" | tail -1)"
      export CLAUDE_CODE_OAUTH_TOKEN
    else
      fail "no CLAUDE_CODE_OAUTH_TOKEN in services/scout-watch/.env: as admin run '$CLAUDE setup-token', sign in with the subscription, and add the line (chmod 600)"
    fi
    if [ "$PROBE_CLAUDE" = 1 ]; then
      reply="$(printf 'Reply with the single word OK.' | "$CLAUDE" -p --model haiku 2>&1 | head -3)"
      case "$reply" in
        *OK*) pass "claude -p answered on the subscription" ;;
        *) fail "claude -p did not answer OK: $reply" ;;
      esac
    fi
  else
    fail "claude CLI not found (set CLAUDE_BIN in services/scout-watch/.env)"
  fi

  avail="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  swap_used="$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo 2>/dev/null)"
  if [ -n "$avail" ] && [ "$avail" -ge 800 ]; then
    pass "memory available ${avail} MB, swap used ${swap_used} MB"
  else
    warn "memory available ${avail:-?} MB, swap used ${swap_used:-?} MB: scout-watch needs about 300 MB, plus about 300 MB during each claude call"
  fi

  # Offsets on 2026-01-01 and 2026-07-01: a New York zone shows both, a fixed EST does not.
  if [ "$(date -d @1767268800 +%z)$(date -d @1782907200 +%z)" = "-0500-0400" ]; then
    pass "timezone $(date +%Z) follows New York daylight saving (cron times are New York time)"
  else
    warn "timezone $(date +%Z) does not follow New York daylight saving: the retro line fires at 12:57 NAS time (fix the NAS timezone in ADM Settings)"
  fi

  heartbeat
  case "$HB_AGE" in
    error) fail "cannot read the scout-watch heartbeat from Supabase" ;;
    none) pass "no scout-watch heartbeat row yet" ;;
    *) note "INFO  scout-watch heartbeat ${HB_AGE}s old: $HB_DETAIL" ;;
  esac
  pid="$(scout_pid)"
  [ -n "$pid" ] && note "INFO  scout-watch runs on this NAS (PID $pid)" || note "INFO  scout-watch does not run on this NAS"
  cron_note "$TAG_SCOUT" scout-watch
  cron_note "$TAG_RETRO" desk-retro
}

# --- commands -----------------------------------------------------------------

cmd_install_retro() {
  need_root || return
  preflight
  if [ "$FAILS" -gt 0 ]; then note "STOP  fix the FAIL lines, then run install-retro again"; return; fi
  cron_replace "$TAG_RETRO" "57 12 * * 1 $(as_owner "cd $REPO && . ./ops/node-env.sh && pnpm --silent retro:remind >> logs/desk-retro-reminder.log 2>&1") $TAG_RETRO"
  cron_has "$TAG_RETRO" && pass "desk-retro cron line installed (Mon 12:57)" || fail "crontab did not take the desk-retro line"
  # The same user and environment as the cron line, so the test proves the cron path.
  if su -l -s /bin/sh "$OWNER" -c "cd $REPO && . ./ops/node-env.sh && pnpm --silent retro:remind --test"; then
    pass "Discord test ping sent: check the channel for 'Test ping from $HOST'"
  else
    fail "Discord test ping failed (see the output above)"
  fi
}

cmd_install_scout() {
  need_root || return
  if [ "$OFFICE_STOPPED" != 1 ]; then
    fail "add --office-stopped once the office box ran 'systemctl --user disable --now scout-watch' and the scout Claude session is stopped"
    return
  fi
  preflight
  if [ "$FAILS" -gt 0 ]; then note "STOP  fix the FAIL lines, then run install-scout again"; return; fi
  # The interlock: a fresh heartbeat from another host means another box still runs it.
  case "$HB_AGE:$HB_DETAIL" in
    none:*|*" host=$HOST") ;;
    *)
      if [ "$HB_AGE" -lt "$FRESH_SEC" ] 2>/dev/null; then
        fail "another scout-watch wrote a heartbeat ${HB_AGE}s ago ($HB_DETAIL). On the office box run 'systemctl --user disable --now scout-watch' (or hl-scout-watch), wait 5 minutes, then run install-scout again"
        return
      fi ;;
  esac
  pid="$(scout_pid)"

  # start.sh exports services/scout-watch/.env to the daemon.
  if ! grep -q '^CLAUDE_BIN=' "$SCOUT_ENV" 2>/dev/null; then
    echo "CLAUDE_BIN=$CLAUDE" >> "$SCOUT_ENV"
    pass "wrote CLAUDE_BIN=$CLAUDE to services/scout-watch/.env"
  fi
  # nas-watch reads the poke bearer from .auto-exit-secret; the daemon reads only its env.
  if ! has_key AUTO_EXIT_CRON_SECRET && ! grep -q '^AUTO_EXIT_CRON_SECRET=' "$SCOUT_ENV" 2>/dev/null && [ -s .auto-exit-secret ]; then
    echo "AUTO_EXIT_CRON_SECRET=$(tr -d ' \r\n' < .auto-exit-secret)" >> "$SCOUT_ENV"
    pass "copied .auto-exit-secret to services/scout-watch/.env"
  fi
  chmod 600 "$SCOUT_ENV"

  cron_replace "$TAG_SCOUT" "@reboot sleep 60 && $(as_owner "cd $SCOUT_DIR && /bin/sh start.sh >> logs/cron-start.log 2>&1") $TAG_SCOUT
*/3 * * * * $(as_owner "cd $SCOUT_DIR && /bin/sh watchdog.sh >> logs/watchdog.log 2>&1") $TAG_SCOUT"
  cron_has "$TAG_SCOUT" && pass "scout-watch cron lines installed (@reboot, */3 watchdog)" || { fail "crontab did not take the scout-watch lines"; return; }

  [ -n "$pid" ] || su -l -s /bin/sh "$OWNER" -c "cd $SCOUT_DIR && /bin/sh start.sh"
  echo "Waiting up to 12 minutes for the first tick and the first consumer cycle..."
  i=0
  while [ "$i" -lt 48 ]; do
    sleep 15
    i=$((i + 1))
    grep -q 'consumer exit=' "$LOG" 2>/dev/null && break
    [ -n "$(scout_pid)" ] || break
  done
  report_scout
}

report_scout() {
  pid="$(scout_pid)"
  [ -n "$pid" ] && pass "scout-watch runs (PID $pid, user $(stat -c %U "/proc/$pid" 2>/dev/null), memory $(rss_mb "[s]cripts/scout-watch.ts") MB)" || fail "scout-watch is not running (tail of $LOG below)"
  heartbeat
  case "$HB_DETAIL" in
    *" host=$HOST")
      if [ "$HB_AGE" -lt "$FRESH_SEC" ] 2>/dev/null; then pass "heartbeat ${HB_AGE}s old from this NAS: $HB_DETAIL"; else fail "heartbeat from this NAS is ${HB_AGE}s old"; fi ;;
    *) fail "heartbeat ${HB_AGE}s old is not from this NAS: $HB_DETAIL" ;;
  esac
  last="$(grep 'consumer exit=' "$LOG" 2>/dev/null | tail -1)"
  case "$last" in
    *"consumer exit=0"*) pass "last consumer cycle: $(echo "$last" | cut -c1-200)" ;;
    "") warn "no consumer cycle in the log yet (it runs every 30 min): run status later" ;;
    *) fail "last consumer cycle failed: $(echo "$last" | cut -c1-200)" ;;
  esac
  echo "--- tail of $LOG ---"
  tail -8 "$LOG" 2>/dev/null
  echo "---"
}

cmd_uninstall_scout() {
  need_root || return
  cron_replace "$TAG_SCOUT" ""
  cron_has "$TAG_SCOUT" && fail "scout-watch cron lines still present" || pass "scout-watch cron lines removed"
  su -l -s /bin/sh "$OWNER" -c "cd $SCOUT_DIR && /bin/sh stop.sh"
  sleep 5
  [ -z "$(scout_pid)" ] && pass "scout-watch stopped on this NAS" || fail "scout-watch still runs (sh services/scout-watch/stop.sh --force)"
}

cmd_uninstall_retro() {
  need_root || return
  cron_replace "$TAG_RETRO" ""
  cron_has "$TAG_RETRO" && fail "desk-retro cron line still present" || pass "desk-retro cron line removed"
}

cmd_status() {
  . ./ops/node-env.sh 2>/dev/null || fail "no Node >= 24"
  report_scout
  cron_note "$TAG_SCOUT" scout-watch
  cron_note "$TAG_RETRO" desk-retro
  last="$(grep 'desk-retro-reminder:' logs/desk-retro-reminder.log 2>/dev/null | tail -1)"
  [ -n "$last" ] && note "INFO  last retro run: $last"
}

PROBE_CLAUDE=0
OFFICE_STOPPED=0
[ "$2" = "--probe-claude" ] && PROBE_CLAUDE=1
[ "$2" = "--office-stopped" ] && OFFICE_STOPPED=1

case "$1" in
  check) preflight; summary check ;;
  install-retro) cmd_install_retro; summary install-retro ;;
  install-scout) cmd_install_scout; summary install-scout ;;
  uninstall-scout) cmd_uninstall_scout; summary uninstall-scout ;;
  uninstall-retro) cmd_uninstall_retro; summary uninstall-retro ;;
  status) cmd_status; summary status ;;
  *) sed -n '2,26p' "$0"; exit 2 ;;
esac
[ "$FAILS" -eq 0 ]
