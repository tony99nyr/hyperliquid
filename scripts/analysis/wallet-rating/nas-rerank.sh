#!/bin/sh
# nas-rerank.sh — NAS crontab entrypoint for the weekly re-rank.
#
# The NAS is an Asustor (ADM, no systemd/DSM). Its crontab runs it Sundays 04:00:
#   0 4 * * 0 cd /volume1/home/admin/hyperliquid/scripts/analysis/wallet-rating && /bin/sh nas-rerank.sh >> ../../../weekly-rerank-cron.log 2>&1
#
# What it does: runs the full discover+rank pipeline (study 01-07 fixed-anchor +
# fills backfill + 4 scorers + consolidate), then UPSERTS the rankings to Supabase
# (cockpit UI + Claude skills read them live). The trade-watch daemon keeps running
# alongside it (see the NOTE below).
# It does NOT git-push (Supabase is the live source; the watcher reads the local
# JSON), so no git push auth is needed.
#
# Everything lives in the ONE hl-cockpit repo — the pipeline, the scorers, the
# cockpit, the trade-watch service, and the Supabase upsert. No second repo.
#
# FIRST RUN regenerates ~5.6 GB of fills/study data from HL's public API (hours).
# Every weekly run after that is incremental. Run it OFF-HOURS.
#
# Prereqs on the NAS: Node 24 (ops/node-env.sh) + pnpm + python3; `pnpm install` in the HL repo;
# .env.local present with the Supabase keys.
#
# EDIT the two paths below for your NAS.
set -u

# --- NAS paths (EDIT THESE) -------------------------------------------------
# The hl-cockpit repo on the NAS (pipeline + cockpit + trade-watch + .env.local).
HL_REPO=/volume1/home/admin/hyperliquid
# Dirs that hold node/pnpm/python3 (a cron shell isn't a login shell → set PATH).
EXTRA_PATH=/usr/local/bin:/usr/bin:/bin
# ---------------------------------------------------------------------------

# NOTE: we deliberately do NOT pause the trade-watch daemon here. The watchdog
# cron (*/3) would just restart it mid-crawl anyway, and a flag-based pause risks
# leaving the watcher stuck down if the re-rank dies. Instead they coexist — the
# crawl backs off on HL 429s and the watcher fail-softs on stale reads. (To pause
# anyway, set RERANK_TRADER_WATCH_DIR="$HL_REPO/services/trader-watch" AND make
# the trade-watch watchdog honor a pause flag.)
export RERANK_LOG="$HL_REPO/weekly-rerank.log"
export PATH="$HL_REPO/node_modules/.bin:$EXTRA_PATH:$PATH"

# Pin Node >= 24 — /usr/local/bin/node (in EXTRA_PATH) is App Central's old v16
. "$HL_REPO/ops/node-env.sh" || { echo "FATAL: no usable Node — see ops/node-env.sh"; exit 1; }

cd "$HL_REPO" || { echo "FATAL: cannot cd $HL_REPO"; exit 1; }

# --no-publish: skip git entirely (the watcher reads the local JSON; the cockpit
# reads Supabase). The script self-locates the repo root from its own path.
exec /bin/sh scripts/analysis/wallet-rating/weekly-rerank.sh --no-publish
