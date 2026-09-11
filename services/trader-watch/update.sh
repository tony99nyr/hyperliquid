#!/bin/sh
# Update and restart the trade-watch service: stop, pull latest, install, restart.
set -e
cd "$(dirname "$0")"

# Resolve Node >= 24 and a working pnpm BEFORE stopping — otherwise a bad
# toolchain fails build.sh under set -e and leaves the service stopped
. ../../ops/node-env.sh
echo "Using $HL_NODE ($("$HL_NODE" -v))"
if ! PNPM_VERSION=$(pnpm -v 2>/dev/null); then
    echo "ERROR: pnpm not usable on PATH — see services/trader-watch/README.md" >&2
    exit 1
fi
echo "Using pnpm $PNPM_VERSION"

echo "Stopping trade-watch…"
./stop.sh 2>/dev/null || true

echo "Pulling latest code…"
( cd ../.. && git pull origin main )

echo "Installing deps…"
./build.sh

echo "Starting trade-watch…"
./start.sh

echo "Done!"
