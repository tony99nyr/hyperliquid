#!/bin/sh
# POSIX-leaning: runs under busybox ash on the NAS (nas-rerank.sh execs it via
# /bin/sh, ignoring this shebang anyway). Uses only ash-supported extensions
# (local, pipefail) — do not introduce bash-only constructs ([[ ]], arrays, ERR traps).
#
# WEEKLY RE-RANK — the full "discover + rank" pipeline that feeds the hl-cockpit.
#
# Runs the ENTIRE Hyperliquid wallet-rating chain end-to-end and PUBLISHES the
# fresh rated-wallets.json into the hl-cockpit repo (/g/hyperliquid), where the
# cockpit + the trade-watch service read it:
#
#   A. STUDY DERIVATION (discover)   01..07 (npx tsx) — universe → portfolios →
#      windows → persistence → persistent-set → anticipation → vaults. Uses the
#      FIXED study anchor (lib.ts ANCHOR_MS = 2026-06-12) so the pre-registered
#      60-day windows + the skill scorer's calendar-pinned regime indices stay
#      valid. (Advancing the anchor is a SEPARATE, occasional manual re-anchor —
#      do NOT slide it weekly.)
#   B. FILLS BACKFILL                backfill-fills.ts --expand N (deep userFills
#      pagination across the universe; resumable).
#   C. SCORERS                       copyability + survivor + skill (python3) +
#      consistency (tsx). Each guarded — one failure does not abort the chain.
#   D. CONSOLIDATE + VALIDATE        consolidate-rated-wallets.mjs → rated-wallets.json,
#      then validate (schema, non-empty, count, required keys) with snapshot/rollback.
#   E. COMMIT (iamrossi)             commit the regen on the current branch.
#   F. PUBLISH (hl-cockpit)          copy → /g/hyperliquid, pull --rebase, commit, push.
#
# It is a heavy, multi-HOUR job (B dominates). Run it WEEKLY, detached, OFF-HOURS,
# and NOT while you care about the trade-watch live feed — both hit Hyperliquid
# from the same IP and share the rate-limit budget.
#
#   npx-free usage (run from anywhere):
#     scripts/analysis/wallet-rating/weekly-rerank.sh                 # full chain + publish+push
#     scripts/analysis/wallet-rating/weekly-rerank.sh --skip-backfill # reuse existing fills (faster)
#     scripts/analysis/wallet-rating/weekly-rerank.sh --no-push       # commit both repos, don't push
#     scripts/analysis/wallet-rating/weekly-rerank.sh --publish-only  # ONLY re-publish current JSON to hl-cockpit (bridge test)
#     scripts/analysis/wallet-rating/weekly-rerank.sh --dry-publish   # show what publish WOULD do, touch no git
#
# Detached weekly run (survives shell exit):
#     setsid nohup scripts/analysis/wallet-rating/weekly-rerank.sh >/tmp/weekly-rerank.boot 2>&1 &
#
# All output -> /tmp/weekly-rerank.log (final line begins with "SUMMARY").
#
set -uo pipefail

# SELF-LOCATING: this script lives in the hl-cockpit repo at
# <repo>/scripts/analysis/wallet-rating/weekly-rerank.sh, so the repo root is 3
# dirs up. The pipeline IS the cockpit repo now (all-in-HL), so REPO == HL_REPO.
# RERANK_REPO can override (e.g. an alt checkout); RERANK_HL_REPO defaults to it.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${RERANK_REPO:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
HL_REPO="${RERANK_HL_REPO:-$REPO}"
WR="$REPO/scripts/analysis/wallet-rating"
STUDY="$REPO/scripts/analysis/hyperliquid-persistence"
HL="$REPO/data/backups/hyperliquid-study"
FILLS_DIR="$HL/fills"
RATED="$REPO/data/backups/wallet-rating/rated-wallets.json"
HL_RATED="$HL_REPO/data/backups/wallet-rating/rated-wallets.json"
HL_BRANCH=main
EXPAND=2437                                   # universe size for the fills backfill
LOG="${RERANK_LOG:-/tmp/weekly-rerank.log}"
# When set to a trade-watch service dir (with stop.sh/start.sh), the heavy HL
# crawl PAUSES the always-on watcher for its duration so the two don't fight over
# HL's per-IP rate limit on the NAS, then resumes it on exit (even on early exit).
TW_DIR="${RERANK_TRADER_WATCH_DIR:-}"

# Flags
SKIP_BACKFILL=0; NO_PUSH=0; NO_PUBLISH=0; PUBLISH_ONLY=0; DRY_PUBLISH=0
for a in "$@"; do case "$a" in
  --skip-backfill) SKIP_BACKFILL=1 ;;
  --no-push)       NO_PUSH=1 ;;
  --no-publish)    NO_PUBLISH=1 ;;   # skip the git commit/push entirely (NAS mode)
  --publish-only)  PUBLISH_ONLY=1 ;;
  --dry-publish)   DRY_PUBLISH=1; PUBLISH_ONLY=1 ;;
  --expand=*)      EXPAND="${a#*=}" ;;
esac; done

# Prefer the repo's local tsx/node on PATH (node/python3 otherwise from the env).
export PATH="$REPO/node_modules/.bin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cd "$REPO" || { echo "FATAL: cannot cd $REPO"; exit 1; }
[ "$PUBLISH_ONLY" -eq 1 ] || : > "$LOG"   # truncate on a full run; append on publish-only
log "=== weekly-rerank START (skip_backfill=$SKIP_BACKFILL no_push=$NO_PUSH publish_only=$PUBLISH_ONLY dry=$DRY_PUBLISH expand=$EXPAND) ==="

count_fills() { find "$FILLS_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
rated_count() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "-1"
import json,sys
try: print(json.load(open(sys.argv[1]))["count"])
except Exception: print(-1)
PY
}
validate_json() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "INVALID:exception"
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    assert d.get("schemaVersion")==1, "schemaVersion!=1"
    w=d.get("wallets"); assert isinstance(w,list) and len(w)>0, "wallets empty"
    assert d.get("count")==len(w), "count mismatch"
    need={"address","short","grades","composite","flags","metrics","sources","tradingActivity"}
    assert need.issubset(set(w[0].keys())), f"missing keys: {need-set(w[0].keys())}"
    print("VALID")
except Exception as e:
    print(f"INVALID:{e}")
PY
}

run_step() {  # run_step <name> <cmd...> ; guarded, logs, never aborts the chain
  local name="$1"; shift
  log "STEP[$name]: $*"
  if "$@" >>"$LOG" 2>&1; then log "STEP[$name]: OK"; else log "STEP[$name]: FAILED (exit $?) — continuing"; fi
}

# --------------------------------------------------------------------------
# PUBLISH: copy the validated rated-wallets.json into the hl-cockpit repo and
# (unless --no-push) push to origin/$HL_BRANCH. Validates the SOURCE first and
# refuses to publish a shrunk/invalid dataset. Idempotent: a no-diff publish is
# a clean no-op.
# --------------------------------------------------------------------------
publish_to_cockpit() {
  log "PUBLISH: → $HL_REPO ($HL_BRANCH)"
  local v; v=$(validate_json "$RATED")
  if [ "$v" != "VALID" ]; then log "PUBLISH: source rated-wallets.json is $v — ABORTING publish."; return 1; fi
  local src_n hl_n; src_n=$(rated_count "$RATED"); hl_n=$(rated_count "$HL_RATED")
  log "PUBLISH: source count=$src_n  cockpit count=$hl_n"
  if [ "$src_n" -lt "$hl_n" ]; then log "PUBLISH: source ($src_n) SHRANK vs cockpit ($hl_n) — ABORTING (won't ship a smaller set)."; return 1; fi

  if [ "$DRY_PUBLISH" -eq 1 ]; then
    if cmp -s "$RATED" "$HL_RATED"; then log "PUBLISH(dry): identical — would be a no-op."; else log "PUBLISH(dry): WOULD update $HL_RATED ($hl_n → $src_n) and ${NO_PUSH:+NOT }push."; fi
    return 0
  fi

  git -C "$HL_REPO" pull --rebase origin "$HL_BRANCH" >>"$LOG" 2>&1 || log "PUBLISH: WARN pull --rebase failed (continuing)"
  # If the pull left a rebase IN PROGRESS (conflict), never commit onto a
  # half-rebased tree — abort it and bail. --publish-only re-runs cleanly once the
  # operator resolves the cockpit repo state.
  local gitdir; gitdir=$(git -C "$HL_REPO" rev-parse --absolute-git-dir 2>/dev/null)
  if [ -n "$gitdir" ] && { [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; }; then
    git -C "$HL_REPO" rebase --abort >>"$LOG" 2>&1 || true
    log "PUBLISH: rebase in progress after pull (conflict) — aborted, NOT publishing. Resolve the cockpit repo + retry --publish-only."
    return 1
  fi
  cp "$RATED" "$HL_RATED" || { log "PUBLISH: cp FAILED"; return 1; }
  if git -C "$HL_REPO" diff --quiet -- data/backups/wallet-rating/rated-wallets.json; then
    log "PUBLISH: no change (cockpit already current) — done."; return 0
  fi
  git -C "$HL_REPO" add data/backups/wallet-rating/rated-wallets.json >>"$LOG" 2>&1
  local gen; gen=$(python3 -c "import json;print(json.load(open('$RATED')).get('generatedAt','?'))" 2>/dev/null)
  git -C "$HL_REPO" commit -m "data(rated-wallets): weekly re-rank — $src_n wallets (generated $gen)

Published from the iamrossi wallet-rating pipeline (weekly-rerank.sh): re-ran the
full discover+rank chain (study 01-07 fixed-anchor + fills backfill + 4 scorers +
consolidate). The cockpit + trade-watch service read this file.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" >>"$LOG" 2>&1 \
    && log "PUBLISH: committed to $HL_REPO" || { log "PUBLISH: commit failed (nothing to commit?)"; return 0; }

  if [ "$NO_PUSH" -eq 1 ]; then log "PUBLISH: --no-push set; committed but not pushed."; return 0; fi
  if git -C "$HL_REPO" push origin "$HL_BRANCH" >>"$LOG" 2>&1; then log "PUBLISH: pushed to origin/$HL_BRANCH."; else log "PUBLISH: push FAILED — commit is local; pull/rebase + retry."; return 1; fi
}

# --------------------------------------------------------------------------
# --publish-only / --dry-publish: skip the heavy chain, just (re)publish.
# --------------------------------------------------------------------------
if [ "$PUBLISH_ONLY" -eq 1 ]; then
  publish_to_cockpit; rc=$?
  log "SUMMARY: publish-only rc=$rc rated=$(rated_count "$RATED") cockpit_now=$(rated_count "$HL_RATED")"
  log "=== weekly-rerank DONE (publish-only) ==="
  exit $rc
fi

PRIOR=$(rated_count "$RATED")
log "prior rated count: $PRIOR  fills now: $(count_fills)"

# Pause the always-on trade-watch during the heavy HL crawl (NAS shared-IP) and
# GUARANTEE it resumes on any exit (success, error, or SIGINT/TERM). No-op when
# RERANK_TRADER_WATCH_DIR is unset (dev box). start.sh is idempotent.
resume_watcher() {
  [ -n "$TW_DIR" ] && [ -x "$TW_DIR/start.sh" ] && { log "resuming trade-watch ($TW_DIR)"; sh "$TW_DIR/start.sh" >>"$LOG" 2>&1 || true; }
}
if [ -n "$TW_DIR" ]; then
  trap resume_watcher EXIT INT TERM
  [ -x "$TW_DIR/stop.sh" ] && { log "pausing trade-watch for the crawl ($TW_DIR)"; sh "$TW_DIR/stop.sh" >>"$LOG" 2>&1 || true; }
fi

# A. STUDY DERIVATION (discover) — fixed anchor; ordered; each guarded.
log "STEP A: study derivation (01-07, fixed anchor) ..."
for s in 01-fetch-universe 02-fetch-portfolios 03-build-windows 04-persistence-stats 05-skill-diagnostics 06-anticipation 07-vaults; do
  run_step "$s" npx tsx "$STUDY/$s.ts"
done

# B. FILLS BACKFILL (deep userFills across the universe) — the long pole.
if [ "$SKIP_BACKFILL" -eq 1 ]; then
  log "STEP B: SKIPPED (--skip-backfill); reusing $(count_fills) cached fills."
else
  run_step backfill npx tsx "$WR/backfill-fills.ts" --expand "$EXPAND"
fi
FILLS_AFTER=$(count_fills); log "fills cached after backfill: $FILLS_AFTER"

# C. SCORERS (4) — guarded; one failure does not abort.
log "STEP C: 4 scorers ..."
run_step copyability  python3 "$WR/rate_hl_copyability.py"
run_step survivor     python3 "$WR/score_hl_survivor.py"
run_step skill        python3 "$WR/score_hl_skill.py"
run_step consistency  npx tsx "$WR/hl-consistency/score-hl-consistency.ts"

# D. CONSOLIDATE + VALIDATE (snapshot → regen → validate → rollback-on-bad).
log "STEP D: consolidate → rated-wallets.json ..."
BACKUP="${RATED}.prev.$(date +%Y%m%d-%H%M%S)"
[ -f "$RATED" ] && cp "$RATED" "$BACKUP" && log "snapshot: $BACKUP"
if ! node "$WR/consolidate-rated-wallets.mjs" >>"$LOG" 2>&1; then
  log "consolidate FAILED — restoring snapshot."; [ -f "$BACKUP" ] && cp "$BACKUP" "$RATED"
  log "SUMMARY: ABORTED at consolidate. fills=$FILLS_AFTER prior_rated=$PRIOR (restored, NOT committed/published)."
  exit 1
fi
NEW=$(rated_count "$RATED"); V=$(validate_json "$RATED")
log "validation: $V  new rated=$NEW (prior $PRIOR)"
if ! { [ "$V" = "VALID" ] && [ "$NEW" -gt 0 ] && [ "$NEW" -ge "$PRIOR" ]; }; then
  log "NOT keeping regen (invalid or shrank). Restoring snapshot."; [ -f "$BACKUP" ] && cp "$BACKUP" "$RATED"
  log "SUMMARY: ABORTED post-consolidate. valid=$V new=$NEW prior=$PRIOR (restored, NOT committed/published)."
  exit 1
fi

# E. COMMIT the regen into the repo (versions rated-wallets.json). SKIPPED under
# --no-publish (NAS mode) — the working-tree JSON is enough for the watcher, the
# cockpit reads Supabase (STEP G), and a local commit would diverge the NAS repo.
if [ "$NO_PUBLISH" -eq 1 ]; then
  log "STEP E: SKIPPED (--no-publish) — not committing the regen locally."
else
  log "STEP E: commit regen ..."
  git -C "$REPO" add data/backups/wallet-rating/rated-wallets.json scripts/analysis/wallet-rating/ >>"$LOG" 2>&1
  git -C "$REPO" commit -m "data(wallet-rating): weekly re-rank — $NEW rated (was $PRIOR), $FILLS_AFTER wallets with fills

Generated by weekly-rerank.sh (full discover+rank: study 01-07 fixed-anchor +
fills backfill + 4 scorers + consolidate).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" >>"$LOG" 2>&1 \
    && log "regen commit OK ($(git -C "$REPO" rev-parse --short HEAD))" || log "regen commit: nothing to commit / failed (see log)."
fi

# F. PUBLISH the JSON to the hl-cockpit. The local working-tree rated-wallets.json
# is ALREADY updated by STEP D (consolidate) — that's what the trade-watch daemon
# reads. This step optionally commits/pushes it (git fallback + Vercel redeploy).
#   --no-publish : skip git entirely (NAS mode — avoids diverging the NAS's HL repo
#                  + needing push auth; the watcher uses the local file, the cockpit
#                  reads Supabase via STEP G).
#   --no-push    : commit locally but don't push (no Vercel redeploy).
if [ "$NO_PUBLISH" -eq 1 ]; then
  log "STEP F: SKIPPED (--no-publish) — local JSON updated for the watcher; cockpit reads Supabase (STEP G)."
else
  publish_to_cockpit || log "PUBLISH step reported a problem (see log)."
fi

# G. UPSERT rated_wallets → Supabase — the cockpit UI + Claude skills read this
# LIVE (no git pull / redeploy). Runs from the HL repo (its tsx + .env.local
# Supabase keys + the db-service). Non-fatal: the cockpit falls back to the
# committed JSON if this fails.
log "STEP G: upsert rated_wallets → Supabase ..."
if ( cd "$HL_REPO" && pnpm upsert-rated --file "$RATED" ) >>"$LOG" 2>&1; then
  log "STEP G: Supabase upsert OK"
else
  log "STEP G: Supabase upsert FAILED (cockpit falls back to committed JSON; see log)"
fi

# Healthchecks dead-man's-switch (optional).
if [ -n "${HEALTHCHECKS_RERANK_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECKS_RERANK_URL" >/dev/null 2>&1 || true
fi

log "SUMMARY: rated=$NEW (was $PRIOR) | fills=$FILLS_AFTER | cockpit_now=$(rated_count "$HL_RATED") | iamrossi_head=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
log "=== weekly-rerank DONE ==="
