#!/bin/sh
# Start the trade-watch service (the non-agent leader poller).
#
# Outbound-only: it opens NO listening port (no cloudflare tunnel needed). It runs
# the repo's `pnpm trader-watch` loop (tsx) from the repo root and tracks the
# process by PID file. Logs go to services/trader-watch/logs/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Repo root is two levels up (services/trader-watch → services → repo root).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/trader-watch.pid"

# Already running? (PID file points at a live process)
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if [ -d "/proc/$PID" ]; then
        echo "Service already running with PID $PID"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

mkdir -p logs

# Archive a non-empty previous log with a timestamp.
LOG_FILE="logs/trader-watch.log"
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    mv "$LOG_FILE" "logs/trader-watch-${TIMESTAMP}.log"
    echo "Archived previous log to logs/trader-watch-${TIMESTAMP}.log"
fi

# Run tsx directly from the repo root for a clean (single-process) PID. Falls back
# to `pnpm --dir` if the local tsx binary is absent.
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
# Cost control: leader positions don't change meaningfully every 30s, and each write
# fans out as a Supabase realtime message + egress. 90s × top-25 (vs 30s × top-50) is
# a ~6x cut in writes/realtime/egress — the dominant Supabase cost driver. Tune via
# TRADER_WATCH_INTERVAL / TRADER_WATCH_TOP.
WATCH_INTERVAL="${TRADER_WATCH_INTERVAL:-90}"
WATCH_TOP="${TRADER_WATCH_TOP:-25}"
if [ -x "$TSX_BIN" ]; then
    ( cd "$REPO_ROOT" && "$TSX_BIN" --tsconfig tsconfig.scripts.json scripts/trader-watch.ts --interval "$WATCH_INTERVAL" --top "$WATCH_TOP" ) \
        > "$LOG_FILE" 2>&1 &
else
    echo "Local tsx not found at $TSX_BIN — falling back to pnpm (run 'pnpm install' in the repo)."
    ( cd "$REPO_ROOT" && pnpm trader-watch --interval "$WATCH_INTERVAL" --top "$WATCH_TOP" ) > "$LOG_FILE" 2>&1 &
fi

echo $! > "$PID_FILE"
echo "Service started with PID $!"
