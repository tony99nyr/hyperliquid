#!/bin/sh
# scout-headless.sh — the ZERO-BABYSITTING scout consumer (C2, 2026-07-03).
#
# One cycle: deterministic snapshot (--json) → a headless cheap-model decision
# (`claude -p`, Sonnet) → strict-JSON execution (scout:trade --from-json, PAPER-ONLY
# hard guard).
#
# SCHEDULING: `pnpm scout:watch` now runs this EMBEDDED (every
# SCOUT_CONSUMER_INTERVAL_MIN, default 30 — one supervised process, no cron
# needed). A standalone cron on any box still works too (the trigger sink is the
# Supabase table, so any box sees the same queue):
#   */30 * * * *  cd /path/to/hyperliquid && ./scripts/scout-headless.sh >> ~/.hl-scout-headless.log 2>&1
# Don't run BOTH on the same queue — the atomic consumed_at claim makes it safe,
# but it doubles model spend for nothing.
#
# The model NEVER sees a shell; it receives the snapshot + playbook as text and must
# reply with ONE JSON object: {"action":"open"|"close"|"stand-down", ...} — anything
# malformed is rejected by parseScoutDecision and NOTHING trades. Most cycles should
# be stand-downs; that is the system working, not failing.
#
# AUTH POLICY (operator rule): the claude CLI runs on the operator's SUBSCRIPTION
# (one-time `claude` login on the box; credentials live in ~/.claude). NEVER set
# ANTHROPIC_API_KEY for this — API billing is not allowed on this desk.
# Cron PATH is minimal: set CLAUDE_BIN to the absolute path if `claude` isn't found
# (find it with `which claude` in an interactive shell; often ~/.npm-global/bin or
# $(npm prefix -g)/bin).
# POSIX sh (busybox ash on the ASUSTOR NAS — no bash there). pipefail is
# supported by busybox ash but guarded for strict-POSIX shells; the bash-only
# ERR trap is gone (set -e still aborts on any failure, and the dead-man ping
# at the tail only fires on full success, so failures page via the missed ping).
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail || true
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
{"action":"propose","coin":"HYPE","title":"<short specific headline>","body":"<the concrete ladder amendment + the evidence: stall/health/tape numbers>","proposalKind":"exit|bank|stop-tighten|disarm|widen-target","paramPx":63.4}

proposalKind makes your advice SCORABLE: a resolver later computes "would acting on it
have helped?" against what actually happened, and your counterfactual track record is
the only path to more authority. 'exit'/'bank' = get out/take profit at the current
mark; 'stop-tighten' REQUIRES paramPx (the new stop). Omit proposalKind only for pure
observations (scored as unscorable 'info').

The propose action is the STEWARD lane: advisory-only review of the LIVE BOOK section
(you can never touch live positions/ladders — a proposal pages the operator on Discord).
Use it when the snapshot's STEWARD REVIEW DUTY finds 2+ signals that a live trade is
turning out of (or into) favor. Repeat titles within 2h are deduped — new evidence
needs a NEW title.

SNAPSHOT:
$SNAPSHOT

PLAYBOOK:
$PLAYBOOK
EOF
)

# stderr stays VISIBLE (expired auth / missing CLI must show up in the cron log).
# Strip markdown code fences (a fenced reply would fail parse every cycle) and take the
# last non-empty line — anything malformed is rejected by parseScoutDecision (no trade).
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
DECISION="$(printf '%s' "$PROMPT" | "$CLAUDE_BIN" -p --model sonnet | sed 's/^```.*$//' | grep -v '^[[:space:]]*$' | tail -1)"
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
