#!/bin/sh
# Start the scout-watch daemon — the FREE deterministic trigger layer of the
# autonomous PAPER scout (pnpm scout:watch, ~60s loop). It writes triggers to a
# JSONL file + a scout_heartbeat row; it NEVER trades (the trade path is in the
# separate interactive scout session via scout:trade, hard-guarded to paper).
#
# Outbound-only: opens NO listening port. Tracks the process by PID file; logs to
# services/scout-watch/logs/. Mirrors services/trader-watch/start.sh.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Repo root is two levels up (services/scout-watch → services → repo root).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/scout-watch.pid"

# DEFENSIVE: this daemon is paper-only by nature (never trades), but pin paper so
# nothing it spawns can ever read a stray live mode. The interactive scout session
# is separately protected by .env.local (paper) + the assertScoutPaperMode guard.
export TRADING_MODE=paper

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
LOG_FILE="logs/scout-watch.log"
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    mv "$LOG_FILE" "logs/scout-watch-${TIMESTAMP}.log"
    echo "Archived previous log to logs/scout-watch-${TIMESTAMP}.log"
fi

# Run tsx directly from the repo root for a clean (single-process) PID. Falls back
# to `pnpm` if the local tsx binary is absent.
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
if [ -x "$TSX_BIN" ]; then
    ( cd "$REPO_ROOT" && "$TSX_BIN" --tsconfig tsconfig.scripts.json scripts/scout-watch.ts ) \
        > "$LOG_FILE" 2>&1 &
else
    echo "Local tsx not found at $TSX_BIN — falling back to pnpm (run 'pnpm install' in the repo)."
    ( cd "$REPO_ROOT" && pnpm scout:watch ) > "$LOG_FILE" 2>&1 &
fi

echo $! > "$PID_FILE"
echo "Service started with PID $!"
