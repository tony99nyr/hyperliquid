#!/bin/sh
# "Build" the research-trader worker. It runs the repo's TypeScript directly via tsx
# (no compile step of its own — same model as `pnpm research-trader-worker`), so
# building == making sure the repo's dependencies are installed. Run from the repo root.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Ensuring repo dependencies are installed (this service runs via tsx)…"
cd "$REPO_ROOT" || exit 1

if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile || pnpm install
else
    echo "pnpm not found — install pnpm (corepack enable) then re-run." >&2
    exit 1
fi

if [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
    echo "Build OK — tsx present, scripts/research-trader-worker.ts ready."
else
    echo "Build incomplete — tsx binary missing after install." >&2
    exit 1
fi
