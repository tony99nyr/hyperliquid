#!/bin/sh
# Update and restart the trade-watch service: stop, pull latest, install, restart.
set -e
cd "$(dirname "$0")"

echo "Stopping trade-watch…"
./stop.sh 2>/dev/null || true

echo "Pulling latest code…"
( cd ../.. && git pull origin main )

echo "Installing deps…"
./build.sh

echo "Starting trade-watch…"
./start.sh

echo "Done!"
