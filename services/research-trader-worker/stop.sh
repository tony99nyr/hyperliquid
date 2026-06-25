#!/bin/sh
# Stop the research-trader worker. Sends SIGTERM so the loop finishes its in-flight
# request and exits cleanly (the script traps SIGTERM). -f/--force escalates to sudo.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/research-trader-worker.pid"
FORCE=0

for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=1 ;;
    esac
done

stopped=0

if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if [ -d "/proc/$pid" ]; then
        kill "$pid" 2>/dev/null && echo "Sent SIGTERM to process $pid (from PID file)" && stopped=1
    else
        echo "PID file exists but process $pid not running, cleaning up"
    fi
    rm -f "$PID_FILE"
fi

# Fallback: find the loop by its script name.
if [ $stopped -eq 0 ]; then
    pids=$(ps -ef 2>/dev/null | grep "[s]cripts/research-trader-worker.ts" | awk '{print $2}')
    for pid in $pids; do
        kill "$pid" 2>/dev/null && echo "Sent SIGTERM to process $pid (found by name)" && stopped=1
    done
fi

if [ "$FORCE" -eq 1 ]; then
    pids=$(ps -ef 2>/dev/null | grep "[s]cripts/research-trader-worker.ts" | awk '{print $2}')
    for pid in $pids; do
        sudo kill -9 "$pid" 2>/dev/null && echo "Force-killed process $pid" && stopped=1
    done
fi

if [ $stopped -eq 0 ]; then
    echo "Service is not running"
else
    echo "Service stop signalled"
fi
