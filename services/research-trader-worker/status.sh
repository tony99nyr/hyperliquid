#!/bin/sh
# Report the research-trader worker status. Outbound-only — no port to probe, so we
# check the PID file + process liveness + recent log activity.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/research-trader-worker.pid"
LOG_FILE="$SCRIPT_DIR/logs/research-trader-worker.log"

echo "=== Research-Trader Worker Status ==="

running=0
if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if [ -d "/proc/$pid" ]; then
        echo "Process: RUNNING (PID $pid)"
        running=1
    else
        echo "Process: NOT RUNNING (stale PID file: $pid)"
    fi
else
    pid=$(ps -ef 2>/dev/null | grep "[s]cripts/research-trader-worker.ts" | awk '{print $2}' | head -1)
    if [ -n "$pid" ]; then
        echo "Process: RUNNING (PID $pid, no PID file)"
        running=1
    else
        echo "Process: NOT RUNNING (no PID file)"
    fi
fi

# Activity — the worker logs a "processed <addr>" line each time it drains a request.
if [ -f "$LOG_FILE" ]; then
    LAST_PROCESSED=$(grep "processed" "$LOG_FILE" 2>/dev/null | tail -1)
    if [ -n "$LAST_PROCESSED" ]; then
        echo "Last processed: $LAST_PROCESSED"
    fi
    echo ""
    echo "=== Recent Logs ==="
    tail -8 "$LOG_FILE"
fi

[ "$running" -eq 1 ] || exit 1
