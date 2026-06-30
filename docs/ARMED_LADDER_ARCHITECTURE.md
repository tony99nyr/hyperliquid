# Armed Ladder — Architecture & Roadmap (plan of record)

Goal: make the cockpit an institutional-grade, **holistic** advanced-strategy execution
tool — a "pick-it-and-it-executes" ladder/bracket system on Hyperliquid that composes
HL's native primitives with a thin deterministic watcher for the conditional logic HL
can't express, plus the institutional risk rules enforced as guardrails.

This doc supersedes the inline plan. It folds in a 3-agent critical review and a
verified deep-research pass (24/25 claims confirmed, mostly HL primary docs, 2026-06).

> ## 0. STATUS — SHIPPED & LIVE (updated 2026-06-29)
>
> The system below is **built, deployed, and live.** First autonomous real-money fire:
> **2026-06-29** — a single-rung ETH short opened on a 15m candle close with an atomic
> protective stop, then self-completed. P0 + P1 are **delivered** (the `LADDER_LIVE_ENABLED`
> / `LADDER_AUTOFIRE_ENABLED` gates are ON in production; the watcher runs via an external
> cron-job.org schedule, not a Vercel cron — Hobby caps crons at daily). **Live-proven:**
> the single-rung `open` → bracket → `done` path. **Built but NOT yet live-exercised:**
> multi-rung adds, the runtime add-coverage gate, and trailing stops (P2/P3).
>
> - **Operate it:** [LADDER_OPERATOR_RUNBOOK.md](./LADDER_OPERATOR_RUNBOOK.md)
> - **Modify it (agents):** [src/lib/ladder/CLAUDE.md](../src/lib/ladder/CLAUDE.md)
> - **As-built deltas** (what shipped beyond this design doc): see §7 below.

---

## 1. The native-vs-watcher boundary (verified against HL primary docs)

**Lean on HL natives — do NOT rebuild them:**

| Native HL primitive | Use for |
|---|---|
| **Scale orders** (evenly-spaced limit ladder across a range, one shot) | laddered *limit* entries |
| **TWAP** (`twapOrder`: 30s slices, 3% per-slice slippage cap, 3× catch-up) | working size in over time / reduce impact |
| **Stop/Take × Market/Limit triggers** (incl. **stop-entry / breakout**, `tpsl:'sl'|'tp'`, fires on mark, 10% slippage tol) | conditional entries/exits on a price level |
| **OCO brackets** (`grouping:'normalTpsl'` = entry+TP+SL set; `'positionTpsl'` = TP/SL attached to a position; children auto-place on fill + **one-cancels-other** + auto-cancel on close) | stop ⇄ target as one managed unit |
| **Builder codes** (fee on routed fills) | monetization path if multi-user |

**Genuinely needs the watcher (the differentiated layer):**
- **Trailing stops** — NOT native; watcher re-prices the stop.
- **Volume / indicator / funding-triggered** rungs — HL triggers are price-on-mark only.
- **Dynamic / auto-resizing partial exits** — a fixed-size TP/SL does NOT resize with the
  position (HL docs), so tracking exits require recompute + replace.
- **Grid** (Scale is one-shot, not replenishing).
- **Multi-leg coordination** (delta-neutral / pairs / hedge legs, leg-risk sequencing).

> Re-verify against live HL docs before each phase — a native trailing stop would move the boundary.

## 2. Institutional practice to encode as guardrails (not just allow)

- **Pyramiding (add to winners):** confirmation-based adds (only after the move proves the
  thesis); **decreasing size per rung** (keeps avg entry near the first — cite the
  principle, not a fixed lot schedule); the inviolable rule — **each new rung's risk must
  be covered by the existing position's unrealized profit**; the aggregate stop **only
  ever tightens** (break-even after the first scale is a *default*, not a mandate — premature
  break-even causes early stop-outs on breakout retests). The opposite of averaging-down.
- **Liquidation-aware sizing:** buffer ≈ 1/leverage (5×→20%, 40×→2.5%); true liq fires at
  maintenance margin (slightly sooner). Already modeled (account-risk + leverage-business-logic).
- **Delta-neutral / cash-and-carry basis:** the normalized institutional 2026 strategy
  (long spot/ETF vs short perp/CME). Inherently **multi-leg** → a holistic platform models
  coupled legs + leg-risk sequencing (P3).

## 3. The capability, and how it stays safe

Operator authors a **multi-asset, multi-rung** plan (thesis + rungs across coins, each
with trigger / size / leverage / stop / target), reviews it in a rich **preview/arm
modal**, and **arms** it with one typed-phrase approval. A deterministic watcher fires
each pre-agreed rung when its condition (price ± volume/funding/indicator on **completed
candles**) hits. Native protective brackets rest on HL as the watcher-independent backstop.

**Founding-rule evolution (operator-approved):** NO-AUTO-FIRE → "real money moves on (a)
explicit Approve, OR (b) a rung PRE-AUTHORIZED in an ARMED ladder, within hard caps,
native stops resting, idempotent, expiring, kill-switchable, deterministic-only." The arm
IS the authorization; the watcher has ZERO discretion. Generalizes the existing
`risk-exit` autonomous endpoint (exit-only → open/add).

**5 non-negotiable invariants:**
1. **Watcher holds no key** — only POSTs to admin-authed Vercel `/ladder/fire-rung`; the
   HL agent key never leaves Vercel (same as the auto-exit NAS→Vercel poke).
2. **Portfolio caps under one ladder-wide lock**, against persisted fills — never
   per-rung-independently (concurrent cross-coin breach).
3. **Rung fire atomic with its stop** — stop-reject auto-flattens; "filled-but-unstopped"
   is a hard fault. (Native OCO bracket makes this one atomic submission.)
4. **Fail-closed on stale + per-rung price bound** — a lagged candle can't open at a
   phantom price; IOC no-fills vs chasing; triggers on completed candles only.
5. **Preview modal fully informed** — worst-case loss if ALL stops hit at once (no
   netting), liq at max aggregate exposure per coin, total notional/margin vs caps,
   expiry — else the typed-phrase consent isn't genuine. Worst-case uses the
   slippage-bounded fill (HL stop = market-on-trigger, 10% tol), not the stop price.
6. **DB-enforced scout/live boundary** — a migration CHECK/trigger pins
   `author='scout' ⇒ mode='paper' AND status≠'armed'`; only the operator **arm route**
   (admin + typed-phrase) may flip `status→armed`/`mode→live`. App-layer alone is not
   enough — a bug or shared upsert must be stopped at Postgres. `/ladder/fire-rung`
   re-reads `mode`/`author` **server-side from the persisted row** (never the request)
   and refuses any `author='scout'` ladder.
7. **Arm-time precondition snapshot** — a rung fires only if live position state still
   matches what was approved (side; existence-for-adds; per-coin leverage). Persist a
   precondition hash at arm; re-check server-side at fire. Any drift (operator closed/
   flipped the position, or changed leverage after arming) → **auto-disarm + alert**,
   never fire against a changed position.

**HL mechanics baked in:** stop-ENTRY uses the native Stop-Market trigger (testnet-rehearse
`tpsl` direction); leverage is per-COIN (all same-coin rungs share one, enforced at arm);
adds = cancel-bracket → add → re-bracket at new avg; deterministic per-rung `cloid` for
exchange-level double-fire rejection.

## 4. Phased roadmap (research-revised)

- **P0 — native bracket, no watcher, no rule change. ✅ COMPLETE (live paths testnet-gated).**
  - ✅ Resting stop (existed) · ✅ Resting take-profit (shipped).
  - ✅ **Native OCO bracket** (`positionTpsl`): stop+target as one mutually-cancelling unit
    — the foundational primitive (commit a2fe082).
  - ✅ Native **stop-entry** leg (breakout/breakdown open, `reduceOnly:false` trigger) +
    EntryModal "Entry type" toggle; sizes server-side off the trigger level; opens WITHOUT
    a stop (loud UI disclosure — operator brackets after fill) (commit 869190e).
  - ⚠ Both new live signing paths (bracket `positionTpsl`, stop-entry `reduceOnly:false`
    trigger) are gated behind the §4b testnet rehearsal — NOT yet exercised on a live key.
- **P1 — single-coin armed ladder + watcher** (migration 0023 with the §3.6 DB
  constraint; `/ladder/arm` typed-phrase; `/ladder/fire-rung` cron-bearer + claim/dedupe
  + `assertLadderArmed` + precondition-snapshot re-check; NAS watcher tick; preview modal).
  - ✅ **P1a foundation** (commit 1f6e234): migration 0023 (ladders/rungs/fires + the
    §3.6 DB CHECK + one-shot fire ledger); `ladder-types.ts`; the PURE authority-free
    `ladder-trigger-evaluator.ts` (fail-closed, completed-candle, split-sink-safe).
  - ✅ **P1b consent math** (commit 0f85ff7): `ladder-risk-business-logic.ts`
    (slippage-bounded no-netting worst-case, per-(coin,side) liq, caps, precondition
    snapshot/hash — self-defending vs risk understatement); `ladder-arm-business-logic.ts`
    (arm-readiness + pyramiding guardrails: decreasing size + tightening stop).
  - ✅ **P1c arm path** (DONE): `ladder-service.ts` service-role CRUD + `/ladder/arm`
    (admin + typed-phrase → validate → snapshot → status='armed'). Arming is AUTHORIZATION
    only — moves no money.
  - ✅ **P1d fire path** (DONE, LIVE): `performLadderRungFire` (the guard stack — see
    [CLAUDE.md](../src/lib/ladder/CLAUDE.md)) via `/ladder/fire-rung` + `/api/cron/ladder-watch`
    (cron-bearer + `ladder_fires` claim/dedupe + author/mode/armed + precondition re-check +
    runtime risk-covered-by-profit + atomic bracket → flatten-on-fault → executeIntent); the
    cron-job.org watcher tick; the rich `LadderDetailModal`. First live fire 2026-06-29.
  Surfaces native **Scale + TWAP**. Watcher owns volume/funding/indicator triggers.
  **MUST also include (moved up from P2 — P1 already adds to a live position):** the
  pyramiding-guardrail enforcement (a rung that *increases* exposure fires only if its
  risk is covered by existing unrealized profit, and only if the aggregate stop ends up
  *tighter*) and the **atomic add→re-bracket** (the enlarged position is bracketed at the
  new full size *before the lock releases*; a re-bracket reject is a hard fault → flatten).
  Partial fills: caps measured against *actual filled* notional; the remainder is dropped,
  not chased. (Shipped + LIVE — `LADDER_LIVE_ENABLED`/`LADDER_AUTOFIRE_ENABLED` ON in prod;
  see §0.)
- **P2 — multi-asset / portfolio / sequencing** (per-coin leverage; portfolio worst-case;
  rung N arms after N-1 fills) + **trailing stops** (watcher).
- **P3 — multi-leg / delta-neutral** (coupled legs, leg-risk sequencing, funding/basis
  triggers) — what makes it genuinely "holistic" beyond single-asset ladders.

## 4b. Live-enablement gate (before `LADDER_LIVE_ENABLED` flips on)

**Two independent kill-switches (so "go live for MANUAL execution" ≠ "enable AFK auto-fire"):**
- `TRADING_MODE=live` — manual cockpit actions sign + submit real money (the global paper↔live switch).
- `LADDER_LIVE_ENABLED` — a LIVE ladder may be ARMED (operator authorization). Default OFF.
- `LADDER_AUTOFIRE_ENABLED` — the watcher / fire-rung route may AUTONOMOUSLY execute a pre-armed
  rung. Default OFF, and the operator can run **fully live for manual trading with this hard-off**.
  The fire route checks it as its single enforcement point (item 7) before any AFK fill.

**Testnet rehearsal checklist — ALL green on `HL_NETWORK=testnet`, long AND short:**
1. Bracket fires the correct leg long and short (stop-entry `tpsl` direction correct).
2. OCO actually one-cancels-other on testnet.
3. Bracket auto-cancels on position close (no orphan).
4. Deterministic `cloid` (= `ladderId:rungId`) rejects a double-submit at the exchange.
5. Leverage is set before the open on a fresh coin (no silent re-rate).
6. Stop-reject → auto-flatten path exercised (the "filled-but-unstopped" fault).
7. Kill-switch: `LADDER_LIVE_ENABLED` off refuses a fire mid-armed.

**Observability — the symmetric risk to a false fire is a SILENT one:**
- **Single enforcement point** = the Vercel fire route. A flipped kill-switch takes
  effect there; an in-flight watcher POST is harmless if the route refuses (worst case =
  one POST). The watcher holds no authority.
- **Armed-but-silent heartbeat:** an armed ladder + no watcher tick in N minutes →
  page the operator. A dead watcher overnight = silent non-protection (rungs AND
  trailing stops don't fire); alert on it as loudly as on a fire.
- **Caps re-validated against the ROUNDED size/price** (formatHlSize floors, formatHlPrice
  clamps) at fire time, not the intended values — a rounded stop can push worst-case loss
  over the previewed number.

## 5. Scout synergy — the ladder grammar is a shared execution language

The Armed Ladder is not just a manual tool; it's an **execution grammar** (rungs =
`{deterministic trigger → pre-authorized order}`, brackets, multi-leg) that the
autonomous **scout** can also speak. Two structural overlaps make this natural:

- **Shared trigger engine — but PURE, with split sinks.** The scout IS an "inverted-loop
  free deterministic trigger daemon"; the ladder watcher is the same pattern. They share
  ONE deterministic condition evaluator — *which is a PURE function emitting only
  `{rungId/laneId, conditionMet}`, holding ZERO execution authority*. The paper sink
  (scout) and the live sink (`/ladder/fire-rung`) are **physically separate**; a routing
  bug in the evaluator can never fire money because the evaluator never executes. The
  live sink re-validates `mode='live'` + `author≠'scout'` + `assertLadderArmed` +
  precondition snapshot server-side before any fill. Build the evaluator once; keep it
  authority-free.
- **Shared execution + risk primitives.** Native brackets/Scale/TWAP, liq-aware sizing,
  and the pyramiding guardrails (decreasing size, risk-covered-by-profit, tightening
  stop) apply identically to scout positions and operator ladders.

**New lanes/strategies the tooling unlocks for the scout (paper):**
1. **Breakout / momentum** — native stop-entry trigger + auto-bracket (the scout can't
   express a conditional entry today; the rung model gives it that).
2. **Pyramiding trend-ride** — scale into winners with the encoded guardrails + a
   (P2) trailing stop.
3. **Delta-neutral funding-carry / basis** (P3 multi-leg) — the funding-dampener idea
   becomes a real coupled long-spot/short-perp leg pair with leg-risk sequencing.
4. **TWAP-worked entries** — larger paper sizes filled via native TWAP → more realistic
   paper fills → cleaner edge measurement.
5. **Event/volume/funding-conditional lanes** — the watcher's non-native triggers let
   the scout test event-driven strategies it currently can't.

**The pipeline (and the boundary).** Scout (PAPER) composes + paper-runs complex ladder
strategies to discover edge → surfaces the proven ones to the operator as pre-built
ladders → operator reviews + **arms** the winner as a LIVE ladder. The ladder grammar is
the bridge from paper-discovery to live-execution. **Boundary preserved:** the scout
stays PAPER-only (hard guard) and may only *propose* a ladder; **only the operator's arm**
moves real money. The scout never arms or fires live itself.

Design consequence: the ladder data model carries an `author` (operator | scout) and
`mode` (paper | live); a scout-authored ladder can run in paper and be *cloned* into an
operator arm — but the scout's write path can never set `mode='live'` or `status='armed'`.

## 6. Reuse map (≈85% existing)

scout/nas-watch (daemon) · `executeIntent` (fire seam) · `preview/decide` (arm + fire
route template) · `claimPreviewForExecute` + `clientIntentId` + `auto_exit_locks`
(idempotency/locks) · `ApprovalPopup` (arm gate) · `PositionInsightsModal` helpers +
`CandleChart`/`buildTradeLines` (preview risk + overlays) · `verifyCronBearer` (keyless
NAS→Vercel auth) · native HL Scale/TWAP/OCO/triggers (compose, don't rebuild).

## 7. As-built (current shipped state — deltas from the design above)

What actually shipped, where it differs from or extends the plan:

- **The watcher runs on cron-job.org, not the NAS/Vercel cron.** Vercel Hobby caps crons
  at daily, so the tick is an external scheduler hitting `GET /api/cron/ladder-watch`
  every ~2 min with `Authorization: Bearer $LADDER_CRON_SECRET`. Triggers evaluate on the
  last **completed 15m** candle (`snapshotFromCandleResult` drops the in-progress bar,
  fails closed on a stale/lagging feed). There is **no dead-watcher heartbeat alert yet**
  (§4b's "armed-but-silent" page) — a known follow-up.

- **Fire sizes at the candle-close mark, not the trigger.** A rung fires when the
  completed candle *closes through* its trigger; `fireOpenOrAdd` then sizes off the live
  **mark** (which overshoots the trigger), so the real fill's entry/stop/size drift from
  the previewed trigger values while **dollar risk and notional stay fixed**
  (`notional = riskUsd/stopFrac`, mark-invariant). Verified live 2026-06-29: $1,602 short
  trigger → ~$1,594 fill → stop $1,674 → $5 risk preserved. The UI states this explicitly.

- **Completion is modeled.** When every rung reaches a terminal status the ladder
  transitions `armed → done` (`markLadderDone`, fire-path, armed-guarded). A `done` ladder
  leaves the watcher set and the cockpit Armed-Ladders panel; the position lives on in
  Open Positions with its resting bracket. The Ladders list shows `done` as "✓ filled".

- **Rich detail/consent UI (beyond the planned preview modal).** `LadderDetailModal` shows
  a 15m chart with every rung's trigger/stop/target overlaid + the live mark (price axis
  auto-stretches to off-candle levels), a per-rung trade card (size/notional/leverage,
  **clean stop risk AND the 10%-slipped max loss**, target/reward/R:R-ideal), a **live
  distance-to-trigger** per rung, the §3.5 aggregate worst-case, and the always-visible
  `arm <id8>` consent phrase. `ArmedLaddersPanel` (cockpit) shows armed ladders with live
  proximity for every coin and is clickable into the same modal. Display math lives in the
  PURE `ladder-projection-business-logic.ts` (`projectRung`/`rungProximity`), which reuses
  `resolveArmRung` for parity.

- **Two kill-switches, both ON in prod.** `LADDER_LIVE_ENABLED` (arm gate) and
  `LADDER_AUTOFIRE_ENABLED` (autonomous-fire gate) are independent of `TRADING_MODE`. See
  `ladder-flags.ts` and the runbook.

**Not yet delivered:** multi-rung live exercise (adds + the add-coverage gate are
unit-tested only), trailing stops (P2), multi-leg/delta-neutral (P3), the dead-watcher
heartbeat, and a per-tick watcher lock for cross-coin portfolio-cap atomicity (§invariant 2
is enforced per-fire today, not under one ladder-wide lock).
