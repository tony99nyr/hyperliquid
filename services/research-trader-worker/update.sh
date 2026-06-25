#!/bin/sh
# Update and restart the research-trader worker: stop, pull latest, install, restart.
set -e
cd "$(dirname "$0")"

echo "Stopping research-trader worker…"
./stop.sh 2>/dev/null || true

echo "Pulling latest code…"
( cd ../.. && git pull origin main )

echo "Installing deps…"
./build.sh

echo "Starting research-trader worker…"
./start.sh

echo "Done!"
