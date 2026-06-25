#!/bin/sh
# Cron-friendly watchdog: ensure the research-trader worker is running; restart it if
# not. Optionally pings Healthchecks.io as a dead-man's switch. Schedule via cron
# (e.g. every 5 min) OR rely on the systemd unit's Restart=always — not both.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/research-trader-worker.pid"

# Load .env (for HEALTHCHECKS_RESEARCH_WORKER_URL) if present.
[ -f "$SCRIPT_DIR/.env" ] && . "$SCRIPT_DIR/.env"

HAD_ERROR=0
echo "$(date): Watchdog check starting..."

# Use /proc/$PID (not kill -0) so a process owned by another user still reads as
# alive.
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if [ ! -d "/proc/$PID" ]; then
        echo "$(date): Service not running (stale PID $PID), restarting..."
        HAD_ERROR=1
        rm -f "$PID_FILE"
        ./start.sh
    else
        echo "$(date): Service healthy (PID $PID)"
    fi
else
    PID=$(ps -ef 2>/dev/null | grep "[s]cripts/research-trader-worker.ts" | awk '{print $2}' | head -1)
    if [ -z "$PID" ]; then
        echo "$(date): Service not running, starting..."
        HAD_ERROR=1
        ./start.sh
    else
        echo "$(date): Found running process $PID, creating PID file"
        echo "$PID" > "$PID_FILE"
    fi
fi

if [ -n "$HEALTHCHECKS_RESEARCH_WORKER_URL" ] && command -v curl >/dev/null 2>&1; then
    if [ "$HAD_ERROR" -eq 1 ]; then
        curl -fsS -m 10 --retry 3 "${HEALTHCHECKS_RESEARCH_WORKER_URL}/fail" >/dev/null 2>&1
    else
        curl -fsS -m 10 --retry 3 "$HEALTHCHECKS_RESEARCH_WORKER_URL" >/dev/null 2>&1
    fi
fi
