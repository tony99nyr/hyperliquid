#!/bin/sh
# Report the scout-watch daemon status. Outbound-only — no port to probe, so we
# check the PID file + process liveness + recent tick activity in the log.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/scout-watch.pid"
LOG_FILE="$SCRIPT_DIR/logs/scout-watch.log"

echo "=== Scout-Watch Daemon Status ==="

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
    pid=$(ps -ef 2>/dev/null | grep "[s]cripts/scout-watch.ts" | awk '{print $2}' | head -1)
    if [ -n "$pid" ]; then
        echo "Process: RUNNING (PID $pid, no PID file)"
        running=1
    else
        echo "Process: NOT RUNNING (no PID file)"
    fi
fi

# Last tick — the loop prints a per-cycle line (triggers / no triggers / stand down).
if [ -f "$LOG_FILE" ]; then
    LAST_TICK=$(grep -E "no triggers|STAND DOWN|⚡|cycle error" "$LOG_FILE" 2>/dev/null | tail -1)
    if [ -n "$LAST_TICK" ]; then
        echo "Last tick: $LAST_TICK"
    fi
    echo ""
    echo "=== Recent Logs ==="
    tail -8 "$LOG_FILE"
fi

[ "$running" -eq 1 ] || exit 1
