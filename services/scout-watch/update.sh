#!/bin/sh
# Update and restart the scout-watch daemon: pull latest, install, then restart.
#
# Runs as the owner of the checkout (admin on the NAS), the user the daemon runs as.
# Started as root (sudo), it re-runs itself as the owner, so root never writes into
# the checkout. Started as another user while the daemon runs, it refuses: stop.sh
# could not signal the daemon, and start.sh would start a second copy (that happened
# to research-trader-worker on 2026-11-23).
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"

owner="$(stat -c %U "$REPO_ROOT/.git")"
if [ "$(id -u)" = 0 ] && [ "$owner" != root ]; then
    exec su -l -s /bin/sh "$owner" -c "sh '$SCRIPT_DIR/update.sh'"
fi

running="$(ps -ef 2>/dev/null | grep "[s]cripts/scout-watch.ts" | awk '{print $2}' | head -1)"
if [ -n "$running" ] && [ "$(stat -c %u "/proc/$running")" != "$(id -u)" ]; then
    echo "scout-watch runs as $(stat -c %U "/proc/$running") (PID $running). Run this as that user." >&2
    exit 1
fi

echo "Pulling latest code…"
( cd "$REPO_ROOT" && git pull origin main )

echo "Installing deps…"
./build.sh

echo "Restarting scout-watch…"
./stop.sh 2>/dev/null || true
i=0
while ps -ef 2>/dev/null | grep -q "[s]cripts/scout-watch.ts"; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
        echo "scout-watch did not stop within 60 s; not restarting. Check: sh status.sh" >&2
        exit 1
    fi
    sleep 1
done
./start.sh
sleep 15
ps -ef 2>/dev/null | grep -q "[s]cripts/scout-watch.ts" || { echo "scout-watch did not stay up: see logs/scout-watch.log" >&2; exit 1; }

echo "Done!"
