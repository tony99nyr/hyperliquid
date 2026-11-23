#!/bin/sh
# Update and restart the scout-watch daemon: pull latest, install, then restart.
#
# On the NAS the daemon runs as root (root's crontab), so run this with sudo. As
# admin, stop.sh cannot signal the root daemon, and start.sh would then start a
# second copy (that happened to research-trader-worker on 2026-11-23). git runs as
# the owner of the checkout (login shell: its HOME has the GitHub SSH key), so
# root never writes root-owned files into it.
set -e
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

running="$(ps -ef 2>/dev/null | grep "[s]cripts/scout-watch.ts" | awk '{print $2}' | head -1)"
if [ -n "$running" ] && [ "$(stat -c %u "/proc/$running")" != "$(id -u)" ]; then
    echo "scout-watch runs as $(stat -c %U "/proc/$running") (PID $running). Run this as that user (on the NAS: sudo sh update.sh)." >&2
    exit 1
fi

echo "Pulling latest code…"
owner="$(stat -c %U "$REPO_ROOT/.git")"
if [ "$(id -u)" = 0 ] && [ "$owner" != root ]; then
    su -l -s /bin/sh "$owner" -c "cd '$REPO_ROOT' && git pull origin main"
else
    ( cd "$REPO_ROOT" && git pull origin main )
fi

echo "Installing deps…"
./build.sh

echo "Restarting scout-watch…"
./stop.sh 2>/dev/null || true
i=0
while ps -ef 2>/dev/null | grep -q "[s]cripts/scout-watch.ts" && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
./start.sh

echo "Done!"
