#!/bin/sh
# Sourced by every NAS-run script ({start,build,update}.sh in services/trader-watch
# and services/research-trader-worker, scripts/nas-watch.sh, nas-rerank.sh) — puts Node >= 24 first on PATH and sets
# HL_NODE to its absolute path. Returns non-zero if none is found.
#
# Why: on the Asustor NAS, /usr/local/bin/node belongs to the App Central
# `nodejs` app, and an app update on 2026-09-02 silently swapped it for v16.
# tsx needs Node >= 18, so every NAS loop (trader-watch, research worker,
# nas-watch steps) died the next time it launched — and the iamrossi relayer
# with them. The NAS now runs a Node 24 we installed ourselves, outside App
# Central's reach (install/upgrade steps: services/trader-watch/README.md).
#
# Resolution order: $NODE_BIN (env override) → the NAS install below →
# whatever `node` is on PATH (dev machines).

HL_NODE_MIN_MAJOR=24
HL_NODE_NAS_DEFAULT=/volume1/home/admin/.local/node/bin/node

HL_NODE=""
for candidate in "${NODE_BIN:-}" "$HL_NODE_NAS_DEFAULT" "$(command -v node 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  # `|| continue`: a candidate that exits non-zero must not trip a caller's set -e
  major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  if [ -n "$major" ] && [ "$major" -ge "$HL_NODE_MIN_MAJOR" ]; then
    HL_NODE="$candidate"
    break
  fi
done

if [ -z "$HL_NODE" ]; then
  echo "ERROR: no Node >= $HL_NODE_MIN_MAJOR found (NODE_BIN=${NODE_BIN:-unset}, PATH node: $(node -v 2>/dev/null || echo none))." >&2
  echo "Install it at $HL_NODE_NAS_DEFAULT or set NODE_BIN (see services/trader-watch/README.md)." >&2
  return 1 2>/dev/null || exit 1
fi

PATH="$(dirname "$HL_NODE"):$PATH"
export PATH
