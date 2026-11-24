#!/bin/sh
# HTPC scout consumer tick: the systemd user timer runs this every 5 minutes.
#
# It runs one headless scout cycle (scripts/scout-headless.sh: snapshot, one Sonnet
# decision, a paper trade or a stand-down) when scout:consumer-due says so. The NAS
# daemon runs with SCOUT_CONSUMER_INTERVAL_MIN=0, so this box is the only consumer.
# Never run a second consumer: two can both open on the same directive.
set -u
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Box-local secrets, kept out of git: CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).
ENV_FILE="${HL_SCOUT_ENV:-$HOME/.config/hl-scout/env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi
# Pin paper after the env file, so a stray TRADING_MODE there cannot win.
export TRADING_MODE=paper
# Desk policy: the claude CLI runs on the subscription only, never on API billing.
unset ANTHROPIC_API_KEY

# Single flight: a slow cycle must not overlap the next tick.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/hl-scout-consumer.lock"
if ! flock -n 9; then
    echo "previous cycle still running, skip"
    exit 0
fi

# Attempt stamp: scout:trade writes the scout-cycle heartbeat only after a handled
# decision, so a failing cycle must still count as a run, or it reruns every tick.
STAMP="$HOME/.local/state/hl-scout/last-attempt"
LAST_ATTEMPT="$(cat "$STAMP" 2>/dev/null || echo 0)"
VERDICT="$(pnpm --silent scout:consumer-due --last-attempt "$LAST_ATTEMPT" 2>&1)"
RC=$?
echo "$VERDICT"
# 3 = not due. Anything else is an error: exit non-zero so systemd records a failed tick.
[ "$RC" -eq 3 ] && exit 0
[ "$RC" -eq 0 ] || exit "$RC"

mkdir -p "$(dirname "$STAMP")" && date +%s > "$STAMP"
# Same hard limit the daemon used for its embedded consumer.
timeout 600 sh scripts/scout-headless.sh
