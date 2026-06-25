#!/bin/sh
# Start the research-trader worker (the on-demand copyability-vetting queue drainer).
#
# Outbound-only: it opens NO listening port (no cloudflare tunnel needed). It runs
# the repo's `pnpm research-trader-worker` loop (tsx) from the repo root and tracks
# the process by PID file. Logs go to services/research-trader-worker/logs/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Repo root is two levels up (services/research-trader-worker → services → repo root).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/research-trader-worker.pid"

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
LOG_FILE="logs/research-trader-worker.log"
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    mv "$LOG_FILE" "logs/research-trader-worker-${TIMESTAMP}.log"
    echo "Archived previous log to logs/research-trader-worker-${TIMESTAMP}.log"
fi

# Run tsx directly from the repo root for a clean (single-process) PID. Falls back
# to `pnpm` if the local tsx binary is absent. The worker takes no args — it polls
# the evaluation_requests queue internally (~5s) and reclaims stuck rows on startup.
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
if [ -x "$TSX_BIN" ]; then
    ( cd "$REPO_ROOT" && "$TSX_BIN" --tsconfig tsconfig.scripts.json scripts/research-trader-worker.ts ) \
        > "$LOG_FILE" 2>&1 &
else
    echo "Local tsx not found at $TSX_BIN — falling back to pnpm (run 'pnpm install' in the repo)."
    ( cd "$REPO_ROOT" && pnpm research-trader-worker ) > "$LOG_FILE" 2>&1 &
fi

echo $! > "$PID_FILE"
echo "Service started with PID $!"
