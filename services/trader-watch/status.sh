#!/bin/sh
# Report the trade-watch service status. Outbound-only — no port to probe, so we
# check the PID file + process liveness + recent log activity.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/trader-watch.pid"
LOG_FILE="$SCRIPT_DIR/logs/trader-watch.log"

echo "=== Trade-Watch Service Status ==="

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
    pid=$(ps -ef 2>/dev/null | grep "[s]cripts/trader-watch.ts" | awk '{print $2}' | head -1)
    if [ -n "$pid" ]; then
        echo "Process: RUNNING (PID $pid, no PID file)"
        running=1
    else
        echo "Process: NOT RUNNING (no PID file)"
    fi
fi

# Heartbeat freshness — the loop logs an "alive" line each cycle.
if [ -f "$LOG_FILE" ]; then
    LAST_ALIVE=$(grep "trade-watch alive" "$LOG_FILE" 2>/dev/null | tail -1)
    if [ -n "$LAST_ALIVE" ]; then
        echo "Last heartbeat: $LAST_ALIVE"
    fi
    echo ""
    echo "=== Recent Logs ==="
    tail -8 "$LOG_FILE"
fi

[ "$running" -eq 1 ] || exit 1
