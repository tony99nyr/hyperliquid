#!/bin/sh
# Update and restart the scout-watch daemon: stop, pull latest, install, restart.
set -e
cd "$(dirname "$0")"

echo "Stopping scout-watch…"
./stop.sh 2>/dev/null || true

echo "Pulling latest code…"
( cd ../.. && git pull origin main )

echo "Installing deps…"
./build.sh

echo "Starting scout-watch…"
./start.sh

echo "Done!"
