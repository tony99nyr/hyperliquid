#!/bin/sh
export PATH="/volume1/home/admin/.local/node/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# nas-doctor.sh: check the NAS side of the HL cockpit, on the NAS, by hand.
#
# Checks the checkout, Node and pnpm, the nas-watch cron line and log, and the
# funding-veto capture archive (hl-observations.json). Then it runs ONE capture to
# prove that the step works. Read-only HL. It writes only the gitignored archive.
# It NEVER trades and never writes to Supabase.
#
# Use (on the NAS, as the user that owns the cron, usually root):
#   cd /volume1/home/admin/hyperliquid && git pull origin main && sh scripts/nas-doctor.sh
#   sh scripts/nas-doctor.sh --no-capture     # report only, write nothing
#
# Paste the lines from "=== SUMMARY ===" down into the desk session.

REPO="${HL_COCKPIT_DIR:-/volume1/home/admin/hyperliquid}"
ARCHIVE="data/backups/hyperliquid-study/cross-venue-funding/hl-observations.json"
LOG="logs/nas-watch.log"
CAPTURE=1
[ "$1" = "--no-capture" ] && CAPTURE=0

SUMMARY=""
FAILS=0
WARNS=0
note() { SUMMARY="$SUMMARY
$1"; echo "$1"; }
pass() { note "PASS  $1"; }
warn() { note "WARN  $1"; WARNS=$((WARNS + 1)); }
fail() { note "FAIL  $1"; FAILS=$((FAILS + 1)); }

cd "$REPO" 2>/dev/null || { echo "FAIL  repo not found at $REPO (set HL_COCKPIT_DIR)"; exit 1; }
echo "=== nas-doctor ($(date -u '+%Y-%m-%d %H:%M:%S') UTC, repo=$REPO, user=$(id -un 2>/dev/null)) ==="

# 1. Checkout: is the capture step in this copy of nas-watch.sh?
HEAD_LINE="$(git log -1 --format='%h %cd' --date=short 2>/dev/null)"
if grep -q "funding-veto capture" scripts/nas-watch.sh 2>/dev/null; then
  pass "checkout $HEAD_LINE has the capture step"
else
  fail "checkout $HEAD_LINE has NO capture step in scripts/nas-watch.sh (run: git pull origin main)"
fi

# 2. Toolchain.
if . ./ops/node-env.sh 2>/dev/null; then pass "node $("$HL_NODE" -v) at $HL_NODE"; else fail "no Node >= 24 (see ops/node-env.sh)"; fi
PNPM="$(command -v pnpm || true)"
if [ -n "$PNPM" ] && "$PNPM" -v >/dev/null 2>&1; then pass "pnpm $("$PNPM" -v) at $PNPM"; else fail "pnpm not usable on PATH"; PNPM=""; fi

# 3. Cron: does a crontab line run nas-watch.sh from THIS repo?
CRON_LINE="$(crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep 'nas-watch.sh' | head -1)"
if [ -z "$CRON_LINE" ]; then
  warn "no nas-watch.sh line in the crontab of $(id -un 2>/dev/null) (the cron may belong to root: run this script as root)"
elif echo "$CRON_LINE" | grep -q "$REPO/scripts/nas-watch.sh"; then
  pass "cron runs $REPO/scripts/nas-watch.sh"
else
  fail "cron runs another copy of nas-watch.sh: $CRON_LINE"
fi

# 4. Log: the last tick and every capture attempt.
if [ -f "$LOG" ]; then
  LAST_TICK="$(grep 'nas-watch tick' "$LOG" | tail -1 | cut -c1-21)"
  pass "last tick in the log: ${LAST_TICK:-none} (NAS local time)"
  ATTEMPTS="$(grep -c 'funding-veto capture' "$LOG")"
  if [ "$ATTEMPTS" -gt 0 ]; then
    pass "the log has $ATTEMPTS capture attempts"
    echo "--- last capture attempt in the log ---"
    grep -n 'funding-veto capture' "$LOG" | tail -1 | cut -d: -f1 | { read -r n; sed -n "${n},$((n + 8))p" "$LOG"; }
    echo "---"
  else
    warn "the log has 0 capture attempts (the step never ran from this log's cron)"
  fi
else
  warn "no $LOG (the cron writes its log to another path, or never ran)"
fi

# 5. Archive before the test capture.
count_rows() {
  "$HL_NODE" -e '
    const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const times = [...new Set(rows.map((r) => r.time))].sort((a, b) => a - b);
    const iso = (t) => new Date(t).toISOString().slice(0, 16) + "Z";
    console.log(times.length + " captures, " + rows.length + " rows, first " + iso(times[0]) + ", last " + iso(times[times.length - 1]));
  ' "$ARCHIVE" 2>&1
}
if [ -f "$ARCHIVE" ]; then
  pass "archive before: $(count_rows)"
else
  warn "archive before: missing ($ARCHIVE)"
fi

# 6. One capture now. An extra capture is harmless: the study reads the latest quote
#    at or before each signal close.
if [ "$CAPTURE" -eq 1 ] && [ -n "$PNPM" ]; then
  echo "--- capture now (pnpm study:funding-veto --capture) ---"
  if OUT="$("$PNPM" study:funding-veto -- --capture 2>&1)"; then
    echo "$OUT" | tail -6
    pass "capture works; archive after: $(count_rows)"
  else
    echo "$OUT" | tail -25
    fail "capture FAILED (the output above is the cause)"
  fi
elif [ "$CAPTURE" -eq 0 ]; then
  note "SKIP  capture (--no-capture)"
fi

# 7. Can the cron user write the archive?
DIR="$(dirname "$ARCHIVE")"
[ -d "$DIR" ] && note "INFO  archive dir owner: $(ls -ld "$DIR" | awk '{print $3":"$4" "$1}')"

echo ""
echo "=== SUMMARY ===$SUMMARY"
if [ "$FAILS" -eq 0 ]; then
  echo "RESULT ok, $WARNS warning(s). The next scheduled captures are 07:55, 15:55 and 23:55 UTC."
else
  echo "RESULT $FAILS failed check(s)."
  exit 1
fi
