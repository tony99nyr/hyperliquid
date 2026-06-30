# Armed Ladder — Agent Coding Guidelines

**Read this before modifying any `src/lib/ladder/**` file, the ladder API routes, the
watcher, or the ladder UI.** This is the one autonomous money-moving subsystem in the
cockpit: an operator arms a multi-rung plan, a deterministic watcher fires each
pre-authorized rung when its trigger hits on a *completed* candle. A bug here can move
real money with no human in the loop. Default to fail-closed; when in doubt, **skip,
never fire**.

For the design rationale + roadmap see [docs/ARMED_LADDER_ARCHITECTURE.md](../../../docs/ARMED_LADDER_ARCHITECTURE.md).
For operating it (arm/fire/disarm, env flags, the cron watcher) see
[docs/LADDER_OPERATOR_RUNBOOK.md](../../../docs/LADDER_OPERATOR_RUNBOOK.md).

## Status
**Shipped + LIVE** (first real fire 2026-06-29: a single-rung ETH short opened
autonomously on a 15m close with an atomic stop, then self-completed). Single-rung
`open` is live-proven; **multi-rung adds + the add-coverage gate are built + unit-tested
but NOT yet exercised against the live exchange** — treat that path as unproven.

## The pieces (canonical locations — don't duplicate)

| File | Role |
|---|---|
| `ladder-types.ts` | The shared shape (mirror of migration 0023). ONE contract for persistence, evaluator, routes, watcher, UI. |
| `ladder-trigger-evaluator.ts` | **PURE, authority-free.** `evaluateLadderRungs` → `{rungId, conditionMet, reason}` and nothing else. Holds zero execution authority by design. |
| `ladder-risk-business-logic.ts` | **PURE** consent math: `computeLadderRisk` (no-netting worst-case w/ 10% stop slippage), per-(coin,side) liq, `addRiskCoveredByProfit`, `buildPreconditionSnapshot`/`hashPreconditionSnapshot`. |
| `ladder-arm-business-logic.ts` | **PURE** arm-readiness: `validateLadderForArm` (pyramiding guardrails), `resolveArmRung` (the canonical sizing), `ladderArmConfirmPhrase`. |
| `ladder-projection-business-logic.ts` | **PURE** display math: `projectRung`, `rungProximity`, `buildLadderChartLines`. UI-only — see the parity rule below. |
| `ladder-service.ts` | Service-role CRUD (server-only). `armLadder` (race-safe), `claimRungFire` (atomic dedupe), `setRungStatus`, `markLadderDone`, `disarmLadder`. |
| `ladder-fire-service.ts` | **The one money-moving site.** `performLadderRungFire` = the guard stack below. |
| `ladder-watch-service.ts` + `ladder-watch-business-logic.ts` | The tick: load armed → build completed-candle snapshots → evaluate → fire met rungs. |
| `ladder-flags.ts` | The two kill-switches + the cron secret resolver. |

Routes: `api/cockpit/ladder/{route,[id],arm,disarm,fire-rung}` + `api/cron/ladder-watch`.
UI: `app/cockpit/components/ladders/{LaddersView,LadderBuilderModal,LadderDetailModal,LadderChart}` + `app/cockpit/components/ArmedLaddersPanel`.

## The fire guard stack — `performLadderRungFire` (memorize this order)

Every step is fail-closed; a failed check SKIPs (rung stays pending, retryable) or
auto-disarms. **Do not reorder, weaken, or short-circuit these.**

0. **`LADDER_AUTOFIRE_ENABLED`** — the belt-and-suspenders kill-switch at the seam (the route checks it first; this is the single enforcement point for *any* caller).
1. Ladder exists, `status='armed'`, not expired (else `disarmLadder('expired')`).
2. **`author='operator'`** — a scout ladder can NEVER fire (defense-in-depth with the DB CHECK).
   - 2b. **mode-match** — a deployment fires only its OWN mode's ladders (`(mode==='live') === (getTradingMode()==='live')`). Checked BEFORE the claim so the matching deployment still fires it.
   - 2c. **`LADDER_LIVE_ENABLED`** re-checked at fire (live kill-switch, not only at arm).
3. Rung exists + `status='pending'`.
4. **Precondition re-check** — re-derive `hashPreconditionSnapshot(buildPreconditionSnapshot(...))` from *current* live state; any drift → `disarmLadder('precondition-drift')`. An unreadable live state (live + position-dependent) THROWS → skip `cannot-verify-precondition` (never a silent "no drift").
5. **Fresh uncached mark** fetched BEFORE the claim — a bad mark skips without burning the one-shot claim.
6. **Atomic claim** via `claimRungFire` (`ladder_fires.dedupe_key` unique). `claimed=false` → skip `already-fired`.
7. Execute: `fireReduce` (reduce/close) or `fireOpenOrAdd` (open/add).
   - **Add gate (§2):** an `add` fires only if `addRiskCoveredByProfit(worstCaseLoss, unrealizedProfit)` — a flat/losing position can't cover an add → `skipped` (anti-martingale; the single most important multi-rung check).
   - **Atomic bracket:** open/add bracket the fill (`placeBracketOnHl`/`placeStopOnHl`); any post-fill throw OR bracket reject → `flattenAfterFault` (the "filled-but-unstopped" hard fault). `loadEffectivePosition` THROWS fail-closed if the live position is unreadable — never falls back to the ledger.
8. On success: `markFireOutcome('filled')` + `setRungStatus('fired')`, then **if every rung is now terminal → `markLadderDone`** (armed-guarded, `.catch`'d, runs AFTER the fill+bracket — can't harm the position).

## Invariants you must not break

- **Parity (with one documented exception).** `projectRung` (display) must reuse
  `resolveArmRung` so the card/preview shows exactly what ARM consents to. **The
  exception, intentional:** the fire path sizes off the live **candle-close mark**, not
  the trigger (`fireOpenOrAdd` → `buildOpenProposal({ entryPx: markPx })`). Since a rung
  fires when the completed candle *closes through* the trigger, the real fill overshoots
  it — so **entry, stop, and size-in-coins drift from the previewed trigger values, but
  the dollar `riskUsd` and the notional (`riskUsd/stopFrac`) are fill-invariant.** The UI
  says so ("fills at the 15m close (may overshoot); dollar risk & notional are fixed").
  If you change either sizing path, keep this relationship and the copy honest.
- **The evaluator holds zero authority.** `ladder-trigger-evaluator.ts` is PURE and emits
  only `{conditionMet}`. NEVER add I/O, keys, or "fire" logic to it — the paper sink
  (scout) and live sink (fire route) are physically separate so a routing bug can't move
  money. The live sink re-validates everything server-side from the persisted row.
- **Completed candle only, fail-closed.** Triggers evaluate on `candles[-2]` (the last
  COMPLETED bar; `[-1]` is in-progress). A stale/lagging/short feed → `stale=true` →
  evaluator never reports met. The in-progress bar must never reach the evaluator.
- **Server re-reads the persisted row, never the request.** `mode`/`author`/`status`/
  rung params all come from `getLadderWithRungs`, not the POST body.
- **Two orthogonal kill-switches + TRADING_MODE.** `LADDER_LIVE_ENABLED` = a live ladder
  may be *armed*; `LADDER_AUTOFIRE_ENABLED` = the watcher may *autonomously fire*. Both
  default OFF and are independent of `TRADING_MODE`. "Go live for manual trading" must
  never imply "let the watcher fire." `forcePaper = !(ladder.mode==='live' && getTradingMode()==='live')` — a paper ladder NEVER touches the live exchange (bracket placement is gated on `!forcePaper`).
- **Money math separation.** `computeLadderRisk` is the *consent* surface (worst-case,
  caps, breaches) — it must stay self-defending against understatement (a stopless rung
  flags UNBOUNDED, not $0). `projectRung` is *display only*. Don't move consent logic into
  the projection or vice-versa.
- **Idempotency is the claim, not the status.** The double-fire guard is the atomic
  `ladder_fires` insert, fetched-fresh-mark-then-claim ordering, and the deterministic
  `cloid = ladderId:rungId`. Don't gate firing on rung status alone.

## Gotchas

- `pickLadders` in `ArmedLaddersPanel` is module-scope ON PURPOSE — an inline `pick`
  passed to `usePolledEndpoint` changes identity every render and re-fires the poll on
  every ws tick (a fetch storm). Keep poll callbacks stable.
- `LadderDetailModal` portals to `document.body` so its inert-siblings focus trap covers
  the whole app (it's rendered from deep inside the cockpit aside). Keep the
  `typeof document === 'undefined'` guard AFTER all hooks.
- A fully-fired ladder transitions to `done` and drops out of `ArmedLaddersPanel` (polls
  `status=armed`); the position lives on in Open Positions with its resting stop. That's
  the intended hand-off, not a disappearance bug.
- Tests: `tests/lib/ladder/**` (108+). When you add a `ladder-service` export that the
  fire path calls, add it to the fire-service test's `vi.mock('@/lib/ladder/ladder-service')`
  or the mocked module returns `undefined` and the `.catch` chain throws.

## Validate
`pnpm type:check && pnpm vitest run tests/lib/ladder/ && pnpm lint`. For UI changes also
proofshot (`scripts/_proof-ladder-detail.ts`) and `pnpm smoke` (note: the cockpit never
reaches networkidle, so the smoke harness's networkidle wait is a known false-fail — the
proofshots are the real visual gate).
