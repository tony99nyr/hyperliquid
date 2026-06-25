# ADR-0005 — The autonomous PAPER scout

Status: Accepted (Phase 4)

## Context

The cockpit's founding rule is **the human confirms every action** — every
entry/exit rides an approval popup (ADR-0001 keeps the seam mode-agnostic; the
human is the stop the leaders lack). But the project needs to answer one
question cheaply, BEFORE any real money: **can Claude find enough trading edge
to be worth running?** Answering it by hand doesn't scale — it needs an agent
that hunts and manages paper trades continuously, on the home PC, against the
Claude *subscription* (no API key burn).

That collides with no-auto-fire. An opportunity finder that paused for a human
on every paper decision would be useless; one that could touch real funds would
be reckless. We need autonomy that is **structurally incapable of touching real
money.**

## Decision

Add an autonomous **paper-only** scout, isolated from the human lane by a hard,
testable boundary.

### 1. PAPER-ONLY is enforced at the seam, not by the caller

The scout is the ONE path that executes `executeIntent` without a human popup.
That autonomy is allowed for `source: 'paper'` fills ONLY:

- `assertScoutPaperMode(mode)` (`src/lib/scout/scout-execution-guard.ts`) throws
  `ScoutLiveExecutionError` unless the process is in paper mode. There is
  intentionally **no flag or env that relaxes it.**
- The boundary **travels with the intent**: `TradeIntent.origin` carries
  `'scout'`, and `executeIntent` itself refuses a scout-origin intent in live
  mode (`fill-source.ts`) — defense in depth beyond the `scout-trade` caller-side
  guard. So no matter who calls the seam, a scout intent can never fill live.
- Pinned by a unit test — this IS the no-auto-fire-for-real-money guarantee for
  the autonomous lane. Real-money trades the scout would propose go to the human
  via the existing `requireApproval` popup (Tier-1), never this path.

### 2. The inverted loop + cheap-model cascade (cost discipline)

Running Opus in a poll loop would be wasteful. Instead:

1. **FREE deterministic daemon** (`pnpm scout:watch`, no model): polls rubric
   scores / fresh marks / open paper positions and appends *material triggers*
   to a JSONL file. Zero tokens — the fast layer.
2. **Cheap model = the scout** (Sonnet, the `scout` skill): woken by a Monitor
   on the trigger file, it vets triggers, runs `pnpm scout:cycle` for the
   decision snapshot, and makes the clear paper calls.
3. **Opus — rare escalation**: only spawned for ambiguous, high-stakes calls.

### 3. A learning loop with a pre-registered bar

- Every paper trade writes a `hypotheses` row (the thesis); closing resolves it
  with the outcome. That + `fills`/`pnl` is the track record.
- Each cycle the scout reads its recent record + `docs/scout/playbook.md` and
  applies the playbook's rules.
- `pnpm scout:review` (the `scout-review` skill — weekly, Opus, NEVER trades)
  scores the record against a **pre-registered kill/graduation bar** (decided
  BEFORE looking at results: paper net P&L incl. modeled funding + slippage) and
  deliberately curates the playbook (the non-recency-biased update step).

## Consequences

- The scout can run unattended for weeks and produce an honest, costed paper
  track record — the gate to ever considering the live seam.
- The paper-only guarantee is one assertion in one file plus the seam check, not
  scattered convention; auditable and test-pinned.
- Open paper positions are covered by three independent layers: the scout
  reviews every open position each wake (risk before opportunity), the crash-safe
  `pnpm watch` daemon writes health/alerts even if the scout session dies, and
  the manual Safe-Exit button. The mode-agnostic auto-exit Layer-1 (ADR-0007)
  can additionally guard paper positions when enabled.
- Graduating to live is NOT automatic: it requires clearing the bar AND the
  separate live gates (ADR-0001 `TRADING_MODE=live` + per-coin allowlist + human
  approval per trade). The scout never flips itself live.
