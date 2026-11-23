#!/bin/sh
# Update and restart the scout-watch daemon: pull latest, install, then restart.
#
# On the NAS the daemon runs as root (root's crontab), so run this with sudo. As
# admin, stop.sh cannot signal the root daemon, and start.sh would then start a
# second copy (that happened to research-trader-worker on 2026-11-23). git runs as
# the owner of the checkout (login shell: its HOME has the GitHub SSH key), and so
# does pnpm install, so root never writes root-owned files into the checkout.
set -e
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

running="$(ps -ef 2>/dev/null | grep "[s]cripts/scout-watch.ts" | awk '{print $2}' | head -1)"
if [ -n "$running" ] && [ "$(stat -c %u "/proc/$running")" != "$(id -u)" ]; then
    echo "scout-watch runs as $(stat -c %U "/proc/$running") (PID $running). Run this as that user (on the NAS: sudo sh update.sh)." >&2
    exit 1
fi

echo "Pulling latest code and installing deps…"
owner="$(stat -c %U "$REPO_ROOT/.git")"
if [ "$(id -u)" = 0 ] && [ "$owner" != root ]; then
    su -l -s /bin/sh "$owner" -c "cd '$REPO_ROOT' && git pull origin main && sh services/scout-watch/build.sh"
else
    ( cd "$REPO_ROOT" && git pull origin main )
    ./build.sh
fi

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
sleep 3
ps -ef 2>/dev/null | grep -q "[s]cripts/scout-watch.ts" || { echo "scout-watch did not start: see logs/scout-watch.log" >&2; exit 1; }

echo "Done!"
