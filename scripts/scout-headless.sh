#!/usr/bin/env bash
# scout-headless.sh — the ZERO-BABYSITTING scout consumer (C2, 2026-07-03).
#
# One cycle: deterministic snapshot (--json) → a headless cheap-model decision
# (`claude -p`, Sonnet) → strict-JSON execution (scout:trade --from-json, PAPER-ONLY
# hard guard). Schedule this via cron on WHICHEVER box you like (the trigger sink is
# the Supabase table, so any box sees the same triggers):
#
#   */30 * * * *  cd /path/to/hyperliquid && ./scripts/scout-headless.sh >> ~/.hl-scout-headless.log 2>&1
#
# The model NEVER sees a shell; it receives the snapshot + playbook as text and must
# reply with ONE JSON object: {"action":"open"|"close"|"stand-down", ...} — anything
# malformed is rejected by parseScoutDecision and NOTHING trades. Most cycles should
# be stand-downs; that is the system working, not failing.
set -euo pipefail
trap 'echo "[scout-headless] FAILED at line $LINENO (see stderr above)" >&2' ERR
cd "$(dirname "$0")/.."

SNAPSHOT="$(pnpm --silent scout:cycle -- --json)"
PLAYBOOK="$(cat docs/scout/playbook.md 2>/dev/null || echo '(no playbook yet)')"

PROMPT=$(cat <<EOF
You are the autonomous PAPER scout (see .claude/skills/scout/SKILL.md — cheap-model lane,
paper-only). Below are your decision snapshot (JSON) and your playbook. Decide ONE action
for this cycle. Rules: manage open positions before opportunities; respect the circuit
breaker (halted => never 'open'); a degraded feed => never 'open'; only open when a setup
clearly beats the playbook bar; stand-down is the correct answer most cycles.

Reply with EXACTLY one JSON object on a single line, no prose, one of:
{"action":"stand-down","note":"<why>"}
{"action":"open","coin":"ETH","side":"buy|sell","riskUsd":50,"stopFrac":0.03,"leverage":3,"lane":"directional","setupType":"breakout|breakdown|reclaim|range-fade|carry|leader-follow|other","regime":"<one word from the snapshot regime>","thesis":"<the hypothesis being tested>"}
{"action":"close","coin":"ETH","sessionId":"<from snapshot positions>","hypothesisId":"<if known>","fraction":1,"note":"<why>"}

SNAPSHOT:
$SNAPSHOT

PLAYBOOK:
$PLAYBOOK
EOF
)

# stderr stays VISIBLE (expired auth / missing CLI must show up in the cron log).
# Strip markdown code fences (a fenced reply would fail parse every cycle) and take the
# last non-empty line — anything malformed is rejected by parseScoutDecision (no trade).
DECISION="$(printf '%s' "$PROMPT" | claude -p --model sonnet | sed 's/^```.*$//' | grep -v '^[[:space:]]*$' | tail -1)"
echo "[scout-headless] decision: $DECISION"
pnpm --silent scout:trade -- --from-json "$DECISION"

# Dead-man ping (healthchecks.io or similar): silence past the grace period pages
# the operator even if this whole box dies. Optional — unset env is a no-op.
# SEMANTIC (deliberate): the ping fires only when the WHOLE cycle succeeded
# (set -e means any failure above skips it) — a crashing claude CLI, a parse
# reject, or a scout-trade error ALSO pages via the missed ping.
if [ -n "${SCOUT_HEADLESS_HEALTHCHECK_URL:-}" ]; then
  curl -fsS -m 10 --retry 2 "$SCOUT_HEADLESS_HEALTHCHECK_URL" >/dev/null || true
fi
