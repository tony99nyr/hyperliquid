# ADR-0008: The arm is the authorisation for armed ladders

Status: Accepted (records the as-built decision; ladders went live 2026-06-29)

## Context

The cockpit's founding rule is **the human confirms every action** (root
`CLAUDE.md`, `docs/CONTEXT.md`). ADR-0005 and ADR-0007 each describe their
autonomous path as the one narrow exception: the scout is paper-only, and the
auto-exit can only reduce or close.

Armed Ladders break that pattern. A ladder is a multi-rung plan (open, add,
reduce, close, `stop_move`) with deterministic triggers. A watcher fires each
rung on a completed candle with no human at the keyboard, and an `open` or `add`
rung takes on NEW live risk. A setup that waits for a level often fires when the
operator is away, so a per-fire approval popup would defeat the purpose.

No decision record covered this. The docs said "the human confirms every action"
while the production watcher opened live positions autonomously.

## Decision

**An operator arm pre-authorises the ladder's autonomous live fires, within the
caps fixed at arm time.** For armed ladders this replaces the literal "the human
confirms every action". The human still confirms, but once, at arm time, against
the full worst case. The watcher has zero discretion: it fires exactly the
persisted rungs, or skips.

The arm is a typed-phrase consent (`arm <first-8-chars-of-id>`) over a risk read
(`computeLadderRisk`: no-netting worst case with 10% stop slippage, per-coin
liquidation, total notional and loss caps). Arm-time breaches block the arm.

### Guardrails (all fail-closed)

1. **Two kill switches, independent of `TRADING_MODE`.** `LADDER_LIVE_ENABLED`
   gates arming a live ladder and is re-checked at fire. `LADDER_AUTOFIRE_ENABLED`
   gates every autonomous fire. Both default OFF.
2. **Mode match.** A deployment fires only ladders whose `mode` equals its own
   trading mode. A paper ladder never touches the live exchange.
3. **The fire guard stack** (`performLadderRungFire`, canonical order in
   `src/lib/ladder/CLAUDE.md`): operator author only, precondition-drift
   re-check, fresh mark before the claim, circuit breaker and book-heat gates on
   live opens/adds, the add-coverage gate, and an atomic bracket (a fill without a
   confirmed resting stop is flattened).
4. **Arm-time caps.** The fire path re-reads the persisted row, never the request,
   so a fire cannot exceed what the operator consented to.
5. **Atomic claims.** One fire per rung via the `ladder_fires` dedupe key. OCO
   `open` rungs claim their whole group (`claim_oco_ladder_fire`, migration 0045),
   so two straddle legs can never both fire.
6. **Auto-exit backstop.** The Layer-1 auto-exit (ADR-0007, live in production)
   still guards the resulting live position.
7. **Disarm-only automation.** The leader guard, trend-flip guard and
   `desk-review` may disarm a ladder. Nothing autonomous may arm one; drafters
   only draft.

## Consequences

- "The human confirms every action" now reads: every action is confirmed by the
  human, either per order (popup) or per ladder (arm). Docs that state the rule
  point here for the ladder case.
- The operator controls are: do not arm, disarm one ladder, or set
  `LADDER_AUTOFIRE_ENABLED=false` to stop all fires. Disarm stops future fires
  only; resting stops stay on the position.
- Operating detail: `docs/LADDER_OPERATOR_RUNBOOK.md`. Design:
  `docs/ARMED_LADDER_ARCHITECTURE.md`. Status: the root `CLAUDE.md` banner.
